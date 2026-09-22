/* 飞牛NAS 手机扫码拍照上传 —— 单屏版前端逻辑 */
(function () {
  'use strict';

  // ---------- 全局状态 ----------
  const state = {
    photographer: localStorage.getItem('photographer') || '',
    workstation: localStorage.getItem('workstation') || '', // 工位：跨刷新/关页恢复
    qr: null,
    stream: null,
    scanning: false,
    torchOn: false,
    photos: [], // { blob, url, capturedAt, seq, uploaded, uploading, failed }
    seq: 0,
    realtime: false,
    watermark: localStorage.getItem('watermark') !== '0', // 照片文字水印，默认开
    ocrWorker: null,
    cfg: { dayStart: 8, nightStart: 20 },
  };

  const TARGET = 20; // 每组约 20 张（软提示，不强制）
  const RING_LEN = 2 * Math.PI * 34; // 快门进度环周长 ≈213.6

  // ---------- 离线持久化（IndexedDB）：照片与上传状态跨刷新/关页存活 ----------
  // 拍照后立即写库；上传成功标记 uploaded；本机存储不可用时静默降级为纯内存模式。
  const DB = (function () {
    const DB_NAME = 'fnnas_photos', STORE = 'photos', V = 1;
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, V);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function put(rec) {
      return open().then((db) => new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = () => res(rec);
        tx.onerror = () => rej(tx.error);
      }));
    }
    function getAll() {
      return open().then((db) => new Promise((res, rej) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      }));
    }
    function del(id) {
      return open().then((db) => new Promise((res) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.onerror = () => {};
        tx.oncomplete = () => res();
      }));
    }
    // 换追溯码/放弃本组时，清掉所有「未上传」记录（已上传的保留在 NAS，不必动）
    function clearPending() {
      return getAll().then((recs) => Promise.all(recs.filter((r) => !r.uploaded).map((r) => del(r.id))));
    }
    return { put, getAll, del, clearPending, available: typeof indexedDB !== 'undefined' };
  })();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const cam = $('cam');

  // ---------- 工具 ----------
  function showModal(id) { $(id).classList.add('show'); }
  function hideModal(id) { $(id).classList.remove('show'); }
  function anyModalOpen() { return !!document.querySelector('.modal.show'); }

  let toastTimer;
  let toastAction = null;
  function toast(msg, opts) {
    const t = $('toast');
    const b = $('toastBtn');
    $('toastMsg').textContent = msg;
    toastAction = null;
    if (opts && typeof opts.action === 'function' && opts.label) {
      toastAction = opts.action;
      b.textContent = opts.label;
      b.classList.add('show');
    } else {
      b.classList.remove('show');
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      toastAction = null;
    }, (opts && opts.duration) || 2600);
  }
  $('toastBtn').addEventListener('click', () => {
    const fn = toastAction;
    toastAction = null;
    $('toast').classList.remove('show');
    clearTimeout(toastTimer);
    if (fn) fn();
  });

  function shiftOf(date) {
    const h = date.getHours();
    return h >= state.cfg.dayStart && h < state.cfg.nightStart ? '白班' : '夜班';
  }

  // ---------- 配置 / 连接状态 ----------
  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 8000);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(timer));
  }

  let connRetryTimer = null;
  async function loadConfig() {
    const el = $('connStatus');
    const dot = $('connDot');
    try {
      const r = await fetchWithTimeout('/api/config');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      state.cfg.dayStart = d.dayStart;
      state.cfg.nightStart = d.nightStart;
      el.textContent = '已连接';
      el.className = 'conn ok';
      dot.className = 'dot ok';
      retryFailed(); // 网络恢复：自动重试之前失败的项
      clearTimeout(connRetryTimer);
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? '请求超时' : (e.message || '网络错误');
      el.textContent = '连接失败(' + reason + ')';
      el.className = 'conn err';
      dot.className = 'dot err';
      clearTimeout(connRetryTimer);
      connRetryTimer = setTimeout(loadConfig, 5000);
    }
  }

  // ---------- 摄像头 ----------
  async function startCamera() {
    stopCamera();
    // v31：App 原生壳经 http 直连时 WebView 是非安全源，不暴露 navigator.mediaDevices，
    // 网页相机整体不可用 → 标记 noWebcam，拍照改走系统相机、扫码改走原生引擎
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      state.noWebcam = true;
      setupNoWebcamUI();
      throw new Error(inShell()
        ? '原生模式：网页相机不可用，拍照与扫码已切换为原生通道'
        : '当前为 http 页面，网页相机不可用：请用 https:// 访问，或使用 App');
    }
    const tries = [
      // v27：ideal 降到 1920x1440（4:3 传感器全幅视野）。过高的 ideal（3000x2000）在部分
      // 手机上会触发传感器裁切（等效数码变焦），画面发糊且视野变小；1920x1440 兼顾视野与解析力
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920, max: 4096 }, height: { ideal: 1440, max: 4096 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920, max: 4096 }, height: { ideal: 1080, max: 2160 } } },
      { audio: false, video: { facingMode: 'environment' } },
      { audio: false, video: true },
    ];
    let lastErr = null;
    for (const c of tries) {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia(c);
        cam.srcObject = state.stream;
        await cam.play();
        state.torchOn = false;
        // 引导连续自动对焦（多数安卓支持；近距拍条码更清晰）
        try {
          const t = state.stream.getVideoTracks()[0];
          await t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) { /* 设备不支持则忽略 */ }
        return;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
      }
    }
    throw lastErr || new Error('摄像头启动失败');
  }

  // 变焦（设备支持时）：factor>1 放大，<1 缩小
  async function setZoom(factor) {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const settings = track.getSettings ? track.getSettings() : {};
      if (!caps.zoom) { toast('该设备不支持变焦，请靠近条码'); return; }
      const cur = settings.zoom || caps.zoom.min || 1;
      const next = Math.min(caps.zoom.max, Math.max(caps.zoom.min, cur * factor));
      await track.applyConstraints({ advanced: [{ zoom: next }] });
    } catch (e) {
      toast('变焦不可用，请靠近条码');
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    if (cam) cam.srcObject = null;
  }

  // ---------- v31：原生壳兜底（无网页相机时的扫码/拍照通道） ----------
  function inShell() {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner) return true;
      return new URLSearchParams(location.search).get('shell') === '1';
    } catch (e) { return false; }
  }

  function setupNoWebcamUI() {
    try {
      ['btnTorch', 'btnZoomIn', 'btnZoomOut'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      const camEl = document.getElementById('cam');
      if (camEl && camEl.parentElement && !document.getElementById('noCamTip')) {
        const tip = document.createElement('div');
        tip.id = 'noCamTip';
        tip.style.cssText = 'position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;text-align:center;color:#8b93a5;font-size:14px;padding:0 24px;line-height:1.9;';
        tip.innerHTML = inShell()
          ? '原生模式：按 <b>拍照键</b> 调用系统相机拍摄<br>追溯码用 App 启动页扫码，或按「识别追溯码」'
          : '当前浏览器不支持网页相机<br>请用 https:// 访问，或使用 App';
        camEl.parentElement.appendChild(tip);
      }
    } catch (e) {}
  }

  // 原生扫码（startScan + 事件监听，CameraX 路径不依赖 GMS），单次识别后自动停止
  function nativeScanOnce() {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if (!B) return Promise.resolve(null);
    const formats = ['CODE_128','CODE_39','CODE_93','QR_CODE','DATA_MATRIX','EAN_13','EAN_8','ITF','PDF_417','UPC_A','UPC_E','AZTEC','CODABAR'];
    return new Promise((resolve) => {
      let handle = null, done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        try { const r = B.stopScan(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
        try { if (handle && handle.remove) handle.remove(); } catch (e) {}
        resolve(code || null);
      };
      B.addListener('barcodeScanned', (res) => {
        const b = res && (res.barcode || (res.barcodes && res.barcodes[0]));
        const code = b && (b.rawValue || b.displayValue || b.value);
        if (code) finish(String(code).trim());
      }).then((h) => {
        handle = h;
        if (!done) {
          const p = B.startScan({ formats });
          if (p && p.catch) p.catch(() => finish(null));
        }
      }).catch(() => finish(null));
      // 兜底：个别版本 addListener 不返回 promise，稍后自行启动
      setTimeout(() => {
        if (!done && !handle) {
          const p = B.startScan({ formats });
          if (p && p.catch) p.catch(() => {});
        }
      }, 500);
      setTimeout(() => finish(null), 120000);
    });
  }

  // 系统相机拍一张（WebView 文件选择器，http 下同样可用）→ 回填到拍照管线
  let _fileCapture = null;
  function ensureFileInput() {
    if (_fileCapture) return _fileCapture;
    _fileCapture = document.createElement('input');
    _fileCapture.type = 'file';
    _fileCapture.accept = 'image/*';
    try { _fileCapture.capture = 'environment'; } catch (e) {}
    _fileCapture.style.display = 'none';
    document.body.appendChild(_fileCapture);
    _fileCapture.addEventListener('change', async () => {
      const f = _fileCapture.files && _fileCapture.files[0];
      _fileCapture.value = '';
      if (f) await shootFromFile(f);
    });
    return _fileCapture;
  }

  // 原生相机拍照（Capacitor Camera 插件）：彻底绕过 WebView 在 http(3080) 非安全源下禁用网页相机的问题。
  // 返回 true=已成功拍并落库；false=插件不可用 / 用户取消 / 异常（调用方回退到系统相机文件选择器）。
  async function nativeCameraCapture() {
    const C = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
    if (!C || !C.getPhoto) return false;
    try {
      const photo = await C.getPhoto({
        quality: 90,
        allowEditing: false,
        correctOrientation: true,
        saveToGallery: false,
        resultType: 'uri',
        source: 'camera',
      });
      const uri = photo && (photo.webPath || photo.path);
      if (!uri) return false;
      const blob = await (await fetch(uri)).blob();
      const file = new File([blob], 'p' + Date.now() + '.jpg', { type: blob.type || 'image/jpeg' });
      await shootFromFile(file);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function shootFromFile(file) {
    if (!validQr()) { toast('请先识别追溯码，再拍摄照片'); return; }
    let img;
    try {
      img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
    } catch (e) { toast('照片读取失败，请重试'); return; }
    const scale = Math.min(1, 4096 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((img.naturalWidth || 1) * scale);
    canvas.height = Math.round((img.naturalHeight || 1) * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    try { URL.revokeObjectURL(img.src); } catch (e) {}
    await addCapturedPhoto(canvas);
  }

  // 从画布出片（原 shoot 后半段抽取，实时流与系统相机共用同一落库/上传管线）
  async function addCapturedPhoto(canvas) {
    const seq = ++state.seq;
    const qrForMark = state.qr;
    if (state.watermark) drawWatermark(canvas, seq, qrForMark);
    shutterFeedback();
    const blob = await encodeJpeg(canvas, 1 * 1024 * 1024, 2 * 1024 * 1024);
    if (!blob) { toast('拍照失败，请重试'); return; }
    const thumb = await makeThumb(canvas, 320); // 随照片上传，供检索页缩略图网格
    const url = URL.createObjectURL(blob);
    const p = { blob, url, thumb, capturedAt: new Date().toISOString(), seq, qr: qrForMark, photographer: state.photographer, workstation: state.workstation, uploaded: false, uploading: false, failed: false, dbId: null };
    // 离线持久化：拍照即落 IndexedDB，刷新/关页后未上传照片也能恢复
    if (DB.available) {
      const rec = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        qr: qrForMark, photographer: state.photographer, workstation: state.workstation, capturedAt: p.capturedAt, seq, blob, thumb, uploaded: false, serverPath: '',
      };
      DB.put(rec).then((r) => { p.dbId = r.id; }).catch(() => {});
    }
    state.photos.push(p);
    renderThumbs(true);
    const f = $('flash');
    f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
    // 实时上传：已识别立即传
    if (state.realtime) uploadOne(p);
  }

  async function toggleTorch() {
    if (!state.stream) { toast('摄像头未开启'); return; }
    const track = state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      state.torchOn = !state.torchOn;
      await track.applyConstraints([{ advanced: [{ torch: state.torchOn }] }][0]);
      $('btnTorch').classList.toggle('on', state.torchOn);
    } catch (e) {
      toast('该设备不支持手电筒');
      state.torchOn = false;
    }
  }

  // ---------- 条码解码：重解码全部交给 Web Worker（off 主线程），彻底杜绝「持续轮询解码」导致的手机发烫 ----------
  // 主线程只负责「抓帧 → 取 RGBA → 投递 Worker → 等结果」；ZXing 解码、灰度拉伸、多方向旋转都在 Worker 内完成。
  let scanRAF = null;
  let scanTimer = null;
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  // 后台解码引擎（Web Worker）：本机不支持时降级提示，不影响拍照。
  let workerBroken = false;
  let decodeWorker = null;
  let decodeSeq = 0;
  const decodePending = new Map();

  function ensureWorker() {
    if (decodeWorker || workerBroken) return decodeWorker;
    try {
      decodeWorker = new Worker('/decode-worker.js');
      decodeWorker.onmessage = (e) => {
        const { id, text } = e.data;
        const p = decodePending.get(id);
        if (p) { decodePending.delete(id); p.resolve(text); }
      };
      decodeWorker.onerror = () => {
        workerBroken = true;
        decodePending.forEach((p) => p.resolve(null));
        decodePending.clear();
        toast('后台解码引擎异常，请用「手动输入」或「识别」');
      };
      return decodeWorker;
    } catch (e) {
      workerBroken = true;
      return null;
    }
  }

  // 投递一帧 RGBA 给 Worker 解码，返回 Promise<text|null>。
  // 拷贝底层 buffer 后 transfer，保留原帧供 jsQR 兜底复用。
  // nativeOnly=true 时 Worker 只走原生 BarcodeDetector 快通道（约 10~30ms），不跑 ZXing 重解码，
  // 用于拍照前「预焙快检」，保证快门即时且不阻塞相机预览。
  function workerDecode(imageData, angles, nativeOnly) {
    const w = ensureWorker();
    if (!w) return Promise.resolve(null);
    const id = ++decodeSeq;
    return new Promise((resolve) => {
      decodePending.set(id, { resolve });
      try {
        const buf = imageData.data.buffer.slice(0);
        w.postMessage({ id, data: buf, width: imageData.width, height: imageData.height, angles: angles || [0], nativeOnly: !!nativeOnly }, [buf]);
      } catch (e) {
        decodePending.delete(id);
        resolve(null);
      }
    });
  }

  // 当前浏览器是否具备原生条码引擎（BarcodeDetector）。用于决定是否走「预焙快检」路径。
  function hasNativeDetect() {
    return (typeof BarcodeDetector !== 'undefined') || (typeof window !== 'undefined' && 'BarcodeDetector' in window);
  }

  // 任意角度旋转 ImageData（canvas 旋转，兼容 45° 等非直角，提升倾斜/俯拍条码命中率）
  function rotateImageData(src, angle) {
    if (angle === 0) return src;
    const w = src.width, h = src.height;
    const rad = angle * Math.PI / 180;
    const dw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const dh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(dw));
    canvas.height = Math.max(1, Math.ceil(dh));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; // 旋转留白填黑，避免透明边干扰解码
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(src, 0, 0);
    ctx.drawImage(tmp, -w / 2, -h / 2);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  // 解码一帧：优先 Worker(ZXing 全格式 + 多方向 + 灰度拉伸)，未命中再 jsQR(二维码) 主线程兜底。
  // 变为异步（返回 Promise），解码全程在 Worker 后台，主线程不卡顿、不发烫。
  async function decodeFrame(img, angles) {
    const list = angles || [0];
    const text = await workerDecode(img, list);
    if (text) return text;
    // jsQR 仅对二维码有效，作为兜底（偶尔一次，开销可忽略）
    for (const ang of list) {
      const cur = ang === 0 ? img : rotateImageData(img, ang);
      const c = window.jsQR(cur.data, cur.width, cur.height, { inversionAttempts: 'dontInvert' });
      if (c && c.data) return c.data;
    }
    return null;
  }

  // 把屏幕上的取景框区域换算成视频像素坐标（自动适配 object-fit: cover / contain 的裁切或留黑边偏移）
  function scanBoxVideoRect() {
    const box = document.querySelector('.scan-box');
    const r = box.getBoundingClientRect();
    const VW = window.innerWidth, VH = window.innerHeight;
    const vw = cam.videoWidth, vh = cam.videoHeight;
    const fit = (getComputedStyle(cam).objectFit || 'cover').toLowerCase();
    // cover：铺满裁切（取大）；contain：完整显示留黑边（取小）；fill：拉伸（无偏移，取宽比）
    const s = fit === 'contain' ? Math.min(VW / vw, VH / vh)
      : fit === 'fill' ? VW / vw
      : Math.max(VW / vw, VH / vh);
    const ox = (vw * s - VW) / 2, oy = (vh * s - VH) / 2;
    let x = (r.left + ox) / s, y = (r.top + oy) / s;
    let w = r.width / s, h = r.height / s;
    x = Math.max(0, Math.min(vw - 2, x));
    y = Math.max(0, Math.min(vh - 2, y));
    w = Math.max(2, Math.min(w, vw - x));
    h = Math.max(2, Math.min(h, vh - y));
    return { x, y, w, h };
  }

  // 抓帧：maxEdge 限制最大边长；useBox=true 时只取取景框区域（条码像素密度更高，识别率大幅提升）
  function grabFrame(maxEdge, useBox) {
    const vw = cam.videoWidth, vh = cam.videoHeight;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (useBox) {
      const r = scanBoxVideoRect();
      sx = r.x; sy = r.y; sw = r.w; sh = r.h;
    }
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const cw = Math.max(1, Math.floor(sw * scale)), ch = Math.max(1, Math.floor(sh * scale));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    cv.getContext('2d', { willReadFrequently: true }).drawImage(cam, sx, sy, sw, sh, 0, 0, cw, ch);
    return cv;
  }

  // 条码区域定位：计算行/列边缘密度，找出条纹密集区（条码特征），返回裁剪矩形。
  // 用于「拍一张识别」前二次裁剪放大，提升低对比/倾斜场景下的 Code128 命中率。
  function locateBarcodeRegion(data, w, h) {
    const rowEdge = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let prev = -1, cnt = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const g = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
        if (prev >= 0 && Math.abs(g - prev) > 20) cnt++;
        prev = g;
      }
      rowEdge[y] = cnt;
    }
    let maxE = 0;
    for (let y = 0; y < h; y++) maxE = Math.max(maxE, rowEdge[y]);
    if (maxE < 8) return null; // 没有明显的条纹密度，放弃定位
    const thr = Math.max(8, maxE * 0.35);
    let top = h, bot = 0;
    for (let y = 0; y < h; y++) if (rowEdge[y] >= thr) { if (y < top) top = y; if (y > bot) bot = y; }
    if (bot - top < h * 0.08) return null;
    const colEdge = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let prev = -1, cnt = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const g = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
        if (prev >= 0 && Math.abs(g - prev) > 20) cnt++;
        prev = g;
      }
      colEdge[x] = cnt;
    }
    let maxC = 0;
    for (let x = 0; x < w; x++) maxC = Math.max(maxC, colEdge[x]);
    if (maxC < 8) return null;
    const thc = Math.max(8, maxC * 0.35);
    let l = w, r = 0;
    for (let x = 0; x < w; x++) if (colEdge[x] >= thc) { if (x < l) l = x; if (x > r) r = x; }
    const padY = Math.round((bot - top) * 0.05), padX = Math.round((r - l) * 0.05);
    top = Math.max(0, top - padY); bot = Math.min(h, bot + padY);
    l = Math.max(0, l - padX); r = Math.min(w, r + padX);
    return { x: l, y: top, w: r - l, h: bot - top };
  }

  // 稳健解码一帧 ImageData：原生引擎(自动旋转) → 四方向 ZXing → 定位放大 + 八方向(小码/倾斜) → jsQR(二维码兜底)。
  // 用于「识别追溯码」按钮、自动识别升级路径，统一高命中率；解码全程在 Worker 后台，主线程不卡顿。
  async function decodeImageDataRobust(id) {
    // 1) 四方向 ZXing（原生优先，见 worker）
    let t = await decodeFrame(id, [0, 90, 180, 270]);
    if (t) return t;
    // 2) 定位条码区域并做多尺度解码（v26：原尺寸/0.6x/1500/2400 四档——高密度长码并非越大越好，
    //    过度放大会把模糊插值放大，原尺寸或适当缩小反而更利落）
    const loc = locateBarcodeRegion(id.data, id.width, id.height);
    if (loc && (loc.w < id.width * 0.98 || loc.h < id.height * 0.98)) {
      const src = document.createElement('canvas');
      src.width = id.width; src.height = id.height;
      src.getContext('2d', { willReadFrequently: true }).putImageData(id, 0, 0);
      const base = Math.max(loc.w, loc.h);
      const scales = [];
      for (const target of [1, 0.6, 1500 / base, 2400 / base]) {
        const s = Math.min(4, Math.max(0.2, target));
        if (!scales.some((v) => Math.abs(v - s) < 0.05)) scales.push(s);
      }
      for (const scale of scales) {
        const cw = Math.max(1, Math.floor(loc.w * scale)), ch = Math.max(1, Math.floor(loc.h * scale));
        if (cw < 8 || ch < 8) continue;
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d', { willReadFrequently: true }).drawImage(src, loc.x, loc.y, loc.w, loc.h, 0, 0, cw, ch);
        t = await decodeFrame(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch), [0, 45, 90, 135, 180, 225, 270, 315]);
        if (t) return t;
      }
    }
    // 3) 整帧八方向兜底
    return await decodeFrame(id, [0, 45, 90, 135, 180, 225, 270, 315]);
  }

  // v27 服务端重型解码：本地解不出时，把定格图发给 NAS（zxing-cpp 引擎 + 定位放大 + 对比度拉伸），
  // 解码能力远强于手机浏览器；失败静默返回 null，自动落到 OCR 兜底。
  function canvasToBlob(canvas, q) {
    return new Promise((res) => {
      try { canvas.toBlob((b) => res(b || null), 'image/jpeg', q || 0.9); } catch (e) { res(null); }
    });
  }
  async function serverDecode(canvas) {
    try {
      const blob = await canvasToBlob(canvas, 0.9);
      if (!blob) return null;
      const fd = new FormData();
      fd.append('image', blob, 'frame.jpg');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch('/api/decode', { method: 'POST', body: fd, signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.ok && d.text) ? String(d.text).trim() : null;
    } catch (e) { return null; }
  }

  // 拍一张静止帧解码（snapScan 显式识别用）：抓整帧走稳健解码流水线。
  async function decodeStill() {
    if (!cam.videoWidth) return null;
    const full = grabFrame(1500, false);
    const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
    return decodeImageDataRobust(id);
  }

  // ---------- 识别模式 UI ----------
  function showScanFrame(on) { $('scanFrame').classList.toggle('show', !!on); }

  function onBarcode(data) {
    state.qr = data.trim();
    state.seq = 0;
    stopScan();
    showScanFrame(false);
    updateCodeChip();
    toast('已识别：' + state.qr);
  }

  // v28+：当运行在 Capacitor 原生壳内时，用手机原生引擎（安卓 ML Kit / iOS Vision）扫码，
  // 识别率远超浏览器 ZXing；扫码成功后直接回填追溯码。非原生环境返回 null，自动走浏览器流水线。
  async function nativeScan() {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if (!B) return null;
    try {
      const perm = (B.requestPermissions && (await B.requestPermissions())) || {};
      const st = perm.camera || perm.barcode;
      if (st && st !== 'granted' && st !== 'authorized' && st !== 'always') return null;
      const { barcodes } = await B.scan();
      const b = barcodes && barcodes[0];
      if (!b) return null;
      return (b.rawValue || b.displayValue || '').trim();
    } catch (e) { return null; }
  }

  // 拍照识别（显式按钮）——「定格识别」流程：
  // 点击后立即抓一张静止画面固定显示在弹层里，对该张照片做多档稳健解码；
  // 用户能看清刚拍到了什么，失败可原地「重新拍摄」或转「手动输入」，不再是对着实时画面盲解。
  function showFreeze(canvas) {
    try { $('freezeImg').src = canvas.toDataURL('image/jpeg', 0.85); } catch (e) { /* 忽略 */ }
    $('freezeTip').textContent = '识别中…';
    showModal('freezeModal');
  }
  function hideFreeze() { hideModal('freezeModal'); }

  async function snapScan() {
    // v31：无网页相机 → 壳内走原生扫码引擎；普通浏览器给出明确指引
    if (state.noWebcam || !cam.videoWidth) {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner) {
        toast('调用手机原生扫码…');
        const t = await nativeScanOnce();
        if (t) { onBarcode(t); } else { toast('未识别到条码，可点「手动输入追溯码」'); }
      } else if (inShell()) {
        toast('原生扫码组件未注入：请回 App 启动页点「开始扫码」');
      } else {
        toast('当前环境无相机：请用 App 打开，或浏览器以 https:// 访问');
      }
      return;
    }
    // 原生壳内：优先用手机原生引擎扫码（ML Kit / Vision），一步到位
    if (window.Capacitor && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('BarcodeScanner')) {
      toast('调用手机原生扫码…');
      const t = await nativeScan();
      if (t) { onBarcode(t); return; }
      // 原生没扫到不阻塞，继续走浏览器流水线兜底
    }
    const btn = $('btnScan');
    if (btn.disabled) return;
    btn.disabled = true;
    showScanFrame(true);
    // 定格两份：取景框区域（条码像素密度高）+ 整帧高清（保底）
    const full = grabFrame(2400, false);
    const box = grabFrame(1600, true);
    showFreeze(full);
    $('freezeTip').textContent = '识别中…（对定格画面解码）';
    const idOf = (cv) => cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
    let text = await decodeImageDataRobust(idOf(box));
    if (!text) text = await decodeImageDataRobust(idOf(full));
    // v27 兜底①：条码解码失败 → 发给 NAS 服务端重型解码（zxing-cpp，定位放大 + 对比度拉伸）
    if (!text) {
      $('freezeTip').textContent = '条码未解出，发送 NAS 服务端解码中…';
      text = await serverDecode(full);
      if (!text) text = await serverDecode(box);
    }
    // 兜底②：仍失败 → 自动 OCR 读取条码下方的印刷数字（28位明文很清晰）
    if (!text) {
      $('freezeTip').textContent = '条码未解出，自动 OCR 读取数字中…（首次加载模型约几秒）';
      try {
        text = await ocrDecode(box);
        if (!text) text = await ocrDecode(full);
      } catch (e) { /* OCR 不可用则维持失败 */ }
    }
    btn.disabled = false;
    showScanFrame(false);
    if (text) {
      hideFreeze();
      onBarcode(text);
    } else {
      $('freezeTip').textContent = '这张没识别出来：靠近些让条码占满取景框、避开反光，点「重新拍摄」再试，或直接「手动输入」';
    }
  }

  // 自动连续识别
  let autoScan = false;
  function toggleAutoScan() {
    autoScan = !autoScan;
    $('btnAutoScan').setAttribute('aria-checked', autoScan ? 'true' : 'false');
    if (autoScan) {
      state.scanning = true;
      showScanFrame(true);
      $('scanTip').textContent = '自动识别中…把条码放入框内';
      loopScan();
      toast('已开启自动识别');
    } else {
      stopScan();
      showScanFrame(false);
    }
  }

  // ---------- OCR 兜底（离线 Tesseract，读取条码下方印刷文字） ----------
  async function getOcrWorker() {
    if (state.ocrWorker) return state.ocrWorker;
    if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎未加载（请检查 /lib/tesseract 资源）');
    const w = await Tesseract.createWorker('eng', 1, {
      corePath: '/lib/tesseract/tesseract-core.wasm.js',
      workerPath: '/lib/tesseract/worker.min.js',
      langPath: '/lib/tesseract/',
      gzip: false,
      logger: () => {},
    });
    await w.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-' });
    state.ocrWorker = w;
    return w;
  }

  async function ocrDecode(canvas) {
    const w = await getOcrWorker();
    const { data } = await w.recognize(canvas);
    const txt = (data && data.text) ? data.text.toUpperCase() : '';
    const tokens = txt.match(/[A-Z0-9-]{6,}/g) || [];
    if (!tokens.length) return null;
    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
  }

  async function onOcrScan() {
    if (!cam.videoWidth) { toast('摄像头未就绪，请稍候'); return; }
    const btn = $('btnOcr');
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '识别中…';
    showScanFrame(true);
    $('scanTip').textContent = 'OCR 识别中（首次需加载模型，约几秒）…';
    try {
      // 优先取景框区域（放大后文字更清晰），失败再试全画面
      let cv = grabFrame(1600, true);
      let t = await ocrDecode(cv);
      if (!t) {
        cv = grabFrame(1600, false);
        t = await ocrDecode(cv);
      }
      showScanFrame(false);
      if (t) onBarcode(t);
      else { $('scanTip').textContent = '未读到条码文字，可手动输入或重试'; toast('OCR 未读到条码下方文字，请手动输入'); }
    } catch (e) {
      showScanFrame(false);
      $('scanTip').textContent = 'OCR 失败：' + (e && e.message || e);
      toast('OCR 失败：' + (e && e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  let lastRotateTry = 0;
  // 自动识别（增强模式，需手动开启）：解码已移入 Worker，主线程几乎零负担；
  // 轮询间隔拉长到 400ms，平时不抓帧、不解码，彻底消除发烫。默认关闭，按需开启。
  function loopScan() {
    if (!state.scanning) return;
    if (cam.readyState >= 2 && cam.videoWidth > 0) {
      // 轻量快通道：取景框小图，Worker 内仅 0° 单次（最快）
      const box = grabFrame(1000, true);
      const bid = box.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, box.width, box.height);
      workerDecode(bid, [0]).then((text) => {
        if (state.scanning && text) { onBarcode(text); return; }
        // 兜底：失败才升级定位放大 + 八方向，且放慢到 ~500ms 一次
        const now = performance.now();
        if (state.scanning && !text && now - lastRotateTry > 500) {
          lastRotateTry = now;
          const full = grabFrame(1500, false);
          const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
          decodeImageDataRobust(id).then((t2) => {
            if (state.scanning && t2) onBarcode(t2);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
    // 节流：轮询间隔 400ms（v22：解码在 Worker，主线程空闲；仅控制抓帧节奏）
    scanTimer = setTimeout(loopScan, 400);
  }

  function stopScan() {
    state.scanning = false;
    if (scanRAF) cancelAnimationFrame(scanRAF);
    scanRAF = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  }

  // 重新开始（换追溯码）：清空本组。v22 不再持续轮询（发烫根因），改为「直接拍照即自动识别」或点「识别」。
  function restartScan() {
    state.photos.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); });
    if (DB.available) DB.clearPending().catch(() => {}); // 放弃本组：清掉未上传的暂存记录
    state.photos = [];
    state.seq = 0;
    state.qr = null;
    updateCodeChip();
    renderThumbs();
    showScanFrame(false);
    stopScan();
    state.scanning = false;
    autoScan = false;
    const a = $('btnAutoScan'); if (a) a.setAttribute('aria-checked', 'false');
    // 提示用户：无需先扫描，直接拍照即可后台识别追溯码；或点「识别」/「手动输入」
    toast('已换追溯码：直接拍照将自动识别，或点「识别」');
  }

  // ---------- 拍照 ----------
  let audioCtx = null;
  function shutterFeedback() {
    try { if (navigator.vibrate) navigator.vibrate(35); } catch (e) {}
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 1500;
      g.gain.setValueAtTime(0.10, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.09);
    } catch (e) {}
  }

  // 体积自适应编码：优先高画质，目标把单张压在 1~2MB 区间。
  // 从高质量试起，若超过 maxBytes(2MB) 则逐级降质量到 ≤2MB；
  // 若最高质量仍 < minBytes(1MB) 也接受（已是最清晰，不强撑体积）。
  function encodeJpeg(canvas, minBytes, maxBytes) {
    minBytes = minBytes || 1 * 1024 * 1024;
    maxBytes = maxBytes || 2 * 1024 * 1024;
    return new Promise((resolve) => {
      // 高质量阶梯：起点抬高到 0.96，清晰照片自然落在 1~2MB
      const quals = [0.96, 0.93, 0.90, 0.86, 0.82, 0.78];
      let idx = 0;
      const step = () => {
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null);
          // 命中：不超过上限；或已是最高质量档（即便偏小也接受）
          if (blob.size <= maxBytes || idx >= quals.length - 1) return resolve(blob);
          idx++;
          step();
        }, 'image/jpeg', quals[idx]);
      };
      step();
    });
  }

  // 生成缩略图：长边缩放到 maxSide，编码 JPEG(0.7)。随照片一并上传，供检索页秒开网格（不拖原图）。
  function makeThumb(canvas, maxSide) {
    return new Promise((resolve) => {
      try {
        const ms = maxSide || 320;
        const scale = Math.min(1, ms / Math.max(canvas.width, canvas.height));
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(canvas, 0, 0, w, h);
        c.toBlob((b) => resolve(b || null), 'image/jpeg', 0.7);
      } catch (e) { resolve(null); }
    });
  }

  // 拍照即识别（v23）：抓拍即时落盘（快门不被 ZXing 拖住），再后台回填追溯码。
  // 预焙前先用「原生条码引擎」做 ~10–30ms 快检：命中即水印正确且快门无感；
  // 无原生引擎/未命中则出片后后台 ZXing 重试回填芯片与记录，该张水印可能暂标「未识别」，后续张正确。
  // 二维码有效性：空 / '未识别' / 'null' 均视为无效，禁止拍照与上传，杜绝无效文件污染归档。
  function validQr() {
    const q = state.qr;
    return !!q && q !== '未识别' && q !== 'null' && q.trim().length > 0;
  }

  async function shoot() {
    // v31/v33：无网页相机（原生壳 http 直连）→ 优先原生相机插件，失败回退系统相机文件选择器
    if (state.noWebcam) {
      if (!validQr()) { toast('请先识别追溯码'); return; }
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera) {
        toast('打开相机…');
        const ok = await nativeCameraCapture();
        if (ok) return;
        // 插件不可用 / 用户取消 → 回退到系统相机文件选择器
      }
      ensureFileInput().click();
      return;
    }
    if (!cam.videoWidth) { toast('摄像头未就绪，请稍候'); return; }
    // 硬锁定：没有有效追溯码禁止拍照（杜绝「未识别/null」照片）。
    // 没码时点快门 = 触发一次识别；识别到码后再次点快门才真正拍摄。
    if (!validQr()) {
      toast('请先识别追溯码：点「识别追溯码」或开启「自动识别」');
      if (cam.videoWidth) snapScan();
      return;
    }
    // —— 即时抓拍 + 水印（追溯码此时必已存在）——
    const canvas = document.createElement('canvas');
    canvas.width = cam.videoWidth; canvas.height = cam.videoHeight;
    canvas.getContext('2d').drawImage(cam, 0, 0);
    await addCapturedPhoto(canvas);
  }

  // 拍照后仍未识别：后台异步跑一次更重的多方向解码（不阻塞继续拍照），命中则回填芯片与记录。
  function backgroundRetryCode(p) {
    try {
      const full = grabFrame(1300, false);
      const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
      workerDecode(id, [0, 45, 90, 135, 180, 225, 270, 315]).then((text) => {
        if (text && !state.qr) {
          state.qr = text.trim();
          updateCodeChip();
          toast('已后台识别追溯码：' + state.qr);
          // 回填补全本张照片记录，并触发其实时上传（若有）
          if (p && p.qr === '未识别') {
            p.qr = state.qr;
            if (DB.available && p.dbId) DB.put({ id: p.dbId, qr: state.qr }).catch(() => {});
            if (state.realtime && !p.uploaded) uploadOne(p);
          }
        }
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  // 在照片底部烧入文字水印：追溯码 / 拍摄者(班次) / 工位 / 拍摄时间 / 序号。
  // 直接画进 JPEG，与照片合为一体，归档后翻图即可溯源。
  // qr 可选：传入则用于本张水印；缺省回退 state.qr（兼容旧调用）。
  function drawWatermark(canvas, seq, qr) {
    const qrText = (qr != null) ? qr : (state.qr || '未识别');
    try {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const ts =
        now.getFullYear() + '.' + p2(now.getMonth() + 1) + '.' + p2(now.getDate()) +
        ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());
      const lines = [
        '追溯码: ' + qrText,
        '拍摄者: ' + (state.photographer || '未知') + '（' + shiftOf(now) + '）',
        '工位: ' + (state.workstation || '—'),
        '时间: ' + ts,
        '第 ' + String(seq).padStart(3, '0') + ' 张',
      ];
      const fs = Math.max(10, Math.round(W * 0.010)); // 更轻量字号：约占图高 10%（v20 水印优化：比 v16 的 0.012 更小）
      const lh = Math.round(fs * 1.18);
      const padX = Math.round(fs * 0.45);
      const padY = Math.round(fs * 0.25);
      const blockH = lines.length * lh + padY;
      // 背景全透明（不画底色块）；不加粗、半透明白字(alpha 0.8) + 柔和阴影：低调不抢画面、亮暗背景都清晰
      ctx.font = fs + 'px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 0;
      ctx.strokeStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; // 约 80% 透明
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.round(fs * 0.1);
      let y = H - blockH;
      for (const line of lines) {
        ctx.fillText(line, padX, y);
        y += lh;
      }
    } catch (e) { /* 水印绘制失败不影响照片本身 */ }
  }

  function updateCounter() {
    const n = state.photos.length;
    $('photoCount').textContent = n;
    const pct = Math.min(1, n / TARGET);
    $('ringFg').style.strokeDashoffset = String(RING_LEN * (1 - pct));
    $('btnShoot').classList.toggle('done', n >= TARGET);
    const btn = $('btnUpload');
    btn.disabled = n === 0 || btn.classList.contains('busy');
    const pending = state.photos.filter((p) => !p.uploaded).length;
    $('uploadLabel').textContent = pending > 0 ? '上传(' + pending + ')' : (n > 0 ? '已传完' : '上传');
    updateRealtimeStatus();
  }

  function updateRealtimeStatus() {
    const el = $('rtStatus');
    if (!state.realtime) { el.innerHTML = ''; return; }
    const total = state.photos.length;
    const done = state.photos.filter((p) => p.uploaded).length;
    const fail = state.photos.filter((p) => p.failed).length;
    let s = `实时上传中 · 已传 <b>${done}</b> / 共 ${total}`;
    if (fail) s += ` · <span style="color:var(--danger)">${fail} 张失败</span>`;
    el.innerHTML = s;
  }

  // ---------- 缩略条（可收起） ----------
  function collapseThumbs(collapsed) {
    $('thumbsWrap').classList.toggle('collapsed', collapsed);
    $('thumbsCaret').textContent = collapsed ? '▾' : '▴';
  }

  function renderThumbs(animateLast) {
    const box = $('thumbs');
    box.innerHTML = '';
    // 没照片时整个缩略区隐藏（含「0 张」开关），避免与「0/20」计数重复占屏
    $('thumbsWrap').classList.toggle('has', state.photos.length > 0);
    state.photos.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      let extra = '';
      if (p.uploading) extra = '<div class="spin"></div>';
      else if (p.uploaded) extra = '<div class="badge up">✓</div>';
      else if (p.failed) extra = '<div class="badge fail">!</div>';
      d.innerHTML = `<img src="${p.url}" alt=""><span class="idx">${p.seq || (i + 1)}</span>${extra}`;
      d.addEventListener('click', () => { if (p.failed) retryFailed(); else confirmDelete(i); });
      box.appendChild(d);
    });
    if (animateLast) {
      const last = box.lastElementChild;
      if (last) last.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
    }
    $('thumbsCount').textContent = state.photos.length;
    updateCounter();
    // 实时上传且有已传照片时，自动收起缩略条，避免占用画面
    if (state.realtime && state.photos.some((p) => p.uploaded)) collapseThumbs(true);
  }

  // 删除确认（大按钮，戴手套也好点）
  let pendingDeleteIndex = -1;
  function confirmDelete(i) {
    const p = state.photos[i];
    if (!p) return;
    pendingDeleteIndex = i;
    $('confirmTitle').textContent = '删除第 ' + (p.seq || (i + 1)) + ' 张？';
    $('confirmMsg').textContent = '删除后可在下方「撤销」恢复（4 秒内）。';
    showModal('confirmModal');
  }
  function doDelete(i) {
    const removed = state.photos.splice(i, 1)[0];
    if (!removed) return;
    if (removed.dbId) DB.del(removed.dbId).catch(() => {});
    renderThumbs();
    toast(`已删除第 ${(removed.seq) || (i + 1)} 张`, {
      label: '撤销',
      action: () => { state.photos.splice(i, 0, removed); renderThumbs(); },
      duration: 4000,
    });
    setTimeout(() => { if (!state.photos.includes(removed)) URL.revokeObjectURL(removed.url); }, 4200);
  }

  // ---------- 上传 ----------
  function uploadOne(p) {
    if (!p || p.uploaded || p.uploading) return;
    if (!validQr()) { toast('没有有效追溯码，无法上传'); return; }
    p.uploading = true;
    renderThumbs();
    const fd = new FormData();
    fd.append('qr', p.qr || state.qr);
    fd.append('photographer', p.photographer || state.photographer);
    fd.append('workstation', p.workstation || state.workstation || '');
    fd.append('metadata', JSON.stringify([{ capturedAt: p.capturedAt, seq: p.seq }]));
    fd.append('photos', p.blob, `p${p.seq}.jpg`);
    if (p.thumb) fd.append('thumbs', p.thumb, 't' + p.seq + '.jpg');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.onload = () => {
      p.uploading = false;
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = null; }
      p.uploaded = !!(xhr.status >= 200 && xhr.status < 300 && d && d.ok);
      if (!p.uploaded) p.failed = true;
      if (p.uploaded && p.dbId) {
        DB.put({ id: p.dbId, qr: p.qr || state.qr, photographer: p.photographer || state.photographer, workstation: p.workstation || '', capturedAt: p.capturedAt, seq: p.seq, blob: p.blob, uploaded: true }).catch(() => {});
      }
      renderThumbs();
      if (p.uploaded) { try { navigator.vibrate && navigator.vibrate(15); } catch (e) {} }
    };
    xhr.onerror = () => { p.uploading = false; p.failed = true; renderThumbs(); };
    xhr.send(fd);
  }

  function setUploadBusy(busy) {
    const btn = $('btnUpload');
    btn.classList.toggle('busy', busy);
    $('btnShoot').classList.toggle('disabled', busy);
    $('btnShoot').disabled = busy;
    updateCounter();
  }

  // 标记某张为已上传（内存 + IndexedDB 同步）
  function markUploaded(p) {
    p.uploaded = true; p.failed = false; p.uploading = false;
    if (p.dbId) {
      DB.put({ id: p.dbId, qr: p.qr || state.qr, photographer: p.photographer || state.photographer, workstation: p.workstation || '', capturedAt: p.capturedAt, seq: p.seq, blob: p.blob, uploaded: true }).catch(() => {});
    }
  }

  // 失败重试：把失败且未上传的项重新发起上传（网络恢复时自动调用，也可手动点）
  function retryFailed() {
    const f = state.photos.filter((p) => p.failed && !p.uploaded && !p.uploading);
    if (!f.length) return;
    f.forEach((p) => { p.failed = false; uploadOne(p); });
    toast(`正在重试 ${f.length} 张失败照片`);
  }

  // 后台批量上传（不跳页，Toast 提示结果）
  function uploadBatch() {
    if (!validQr()) { toast('没有有效追溯码，无法上传'); return; }
    const pending = state.photos.filter((p) => !p.uploaded && !p.uploading);
    if (pending.length === 0) { toast('没有待上传的照片'); return; }
    setUploadBusy(true);
    $('uploadLabel').textContent = '上传中…';
    const fd = new FormData();
    fd.append('qr', state.qr);
    fd.append('photographer', state.photographer);
    fd.append('workstation', state.workstation || '');
    fd.append('metadata', JSON.stringify(pending.map((p) => ({ capturedAt: p.capturedAt, seq: p.seq }))));
    pending.forEach((p) => {
      fd.append('photos', p.blob, `p${p.seq}.jpg`);
      if (p.thumb) fd.append('thumbs', p.thumb, 't' + p.seq + '.jpg');
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('uploadLabel').textContent = '上传中 ' + Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = () => {
      setUploadBusy(false);
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = { ok: false, saved: [], error: '服务器返回异常' }; }
      const okSeqs = (d && d.saved) ? d.saved.map((s) => s.seq) : [];
      if (xhr.status >= 200 && xhr.status < 300 && d.ok) {
        pending.forEach((p) => markUploaded(p));
        renderThumbs();
        toast(`✅ 已上传 ${d.count} 张到飞牛NAS`);
        try { navigator.vibrate && navigator.vibrate([40, 60, 40]); } catch (e) {}
      } else {
        // 服务端返回逐张结果：精确标记成功/失败，失败的可稍后重试（绝不静默丢弃）
        pending.forEach((p) => {
          if (okSeqs.indexOf(p.seq) >= 0) markUploaded(p);
          else p.failed = true;
        });
        renderThumbs();
        toast('部分/全部上传失败（' + (d && d.error || '未知错误') + '），点失败角标或「上传」可重试');
      }
    };
    xhr.onerror = () => {
      setUploadBusy(false);
      pending.forEach((p) => { p.failed = true; });
      renderThumbs();
      toast('网络错误，上传失败，可再点上传重试');
    };
    xhr.send(fd);
  }

  // ---------- 顶栏信息 ----------
  function updateCodeChip() {
    const el = $('codeChip');
    if (state.qr) {
      el.textContent = '追溯码：' + state.qr;
      el.classList.remove('warn');
    } else {
      el.textContent = '追溯码：未识别';
      el.classList.add('warn');
    }
    $('whoChip').textContent = '拍摄者：' + (state.photographer || '—');
    $('stationChip').textContent = '工位：' + (state.workstation || '—');
    // 快门锁：无有效追溯码时变灰提示，引导先识别
    const shootBtn = $('btnShoot');
    if (shootBtn) shootBtn.classList.toggle('locked', !validQr());
  }

  // ---------- 事件绑定 ----------
  function openWhoModal() {
    $('photographer').value = state.photographer;
    $('workstation').value = state.workstation;
    showModal('whoModal');
    setTimeout(() => $('photographer').focus(), 50);
  }
  function bind() {
    // 拍摄者
    $('photographer').addEventListener('input', (e) => {
      state.photographer = e.target.value.trim();
      localStorage.setItem('photographer', state.photographer);
      updateCodeChip();
    });
    $('btnWhoOk').addEventListener('click', () => {
      state.photographer = $('photographer').value.trim();
      localStorage.setItem('photographer', state.photographer);
      // 工位可选填写，不强制
      state.workstation = $('workstation').value.trim();
      localStorage.setItem('workstation', state.workstation);
      if (!state.photographer) { toast('请先填写拍摄者姓名'); return; }
      updateCodeChip();
      hideModal('whoModal');
    });
    $('whoChip').addEventListener('click', openWhoModal);
    $('stationChip').addEventListener('click', openWhoModal);

    // 顶栏开关
    $('btnRealtime').addEventListener('click', () => {
      state.realtime = !state.realtime;
      $('btnRealtime').setAttribute('aria-checked', state.realtime ? 'true' : 'false');
      updateRealtimeStatus();
      toast(state.realtime ? '已开启实时上传：每拍一张立即上传' : '已关闭实时上传');
    });
    $('btnAutoScan').addEventListener('click', toggleAutoScan);
    $('btnWatermark').addEventListener('click', () => {
      state.watermark = !state.watermark;
      localStorage.setItem('watermark', state.watermark ? '1' : '0');
      $('btnWatermark').setAttribute('aria-checked', state.watermark ? 'true' : 'false');
      toast(state.watermark ? '已开启水印：照片底部显示追溯码/拍摄者/工位/时间' : '已关闭水印');
    });
    // 换追溯码：顶部与竖屏底部两处入口共用
    const onNewQrClick = () => {
      stopScan(); // 立即暂停自动识别循环，把主线程让给本次点击，按钮响应即时
      const unsaved = state.photos.filter((p) => !p.uploaded).length;
      if (unsaved > 0) {
        $('confirmTitle').textContent = '放弃本组？';
        $('confirmMsg').textContent = `还有 ${unsaved} 张未上传，确定放弃并换追溯码？`;
        pendingDeleteIndex = -2; // 特殊标记：确认后执行 restartScan
        showModal('confirmModal');
      } else {
        restartScan();
      }
    };
    $('btnNewQr').addEventListener('click', onNewQrClick);
    const btnNewQr2 = document.getElementById('btnNewQr2');
    if (btnNewQr2) btnNewQr2.addEventListener('click', onNewQrClick);

    // 追溯码点击：未识别时点一下即显式识别（拍照即识别的手动入口）；已识别则复制
    $('codeChip').addEventListener('click', async () => {
      if (!state.qr) { snapScan(); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(state.qr);
        else { const ta = document.createElement('textarea'); ta.value = state.qr; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        toast('追溯码已复制');
      } catch (e) { toast('复制失败，可长按追溯码手动复制'); }
    });

    // 底部操作栏
    $('btnScan').addEventListener('click', snapScan);
    $('btnShoot').addEventListener('click', shoot);
    $('btnUpload').addEventListener('click', uploadBatch);
    $('btnTorch').addEventListener('click', toggleTorch);

    // 识别模式内按钮
    $('btnOcr').addEventListener('click', onOcrScan);
    $('btnZoomIn').addEventListener('click', () => setZoom(1.3));
    $('btnZoomOut').addEventListener('click', () => setZoom(1 / 1.3));
    $('btnManual').addEventListener('click', () => { $('manualInput').value = ''; showModal('manualModal'); setTimeout(() => $('manualInput').focus(), 50); });
    // 定格识别弹层按钮
    $('btnFreezeRetry').addEventListener('click', () => { hideFreeze(); setTimeout(() => snapScan(), 120); });
    $('btnFreezeManual').addEventListener('click', () => { hideFreeze(); $('manualInput').value = ''; showModal('manualModal'); setTimeout(() => $('manualInput').focus(), 50); });
    $('btnFreezeClose').addEventListener('click', () => hideFreeze());
    function manualSubmit() {
      const v = $('manualInput').value.trim();
      if (!v) { toast('请输入条码下方的数字/字母'); return; }
      hideModal('manualModal');
      onBarcode(v);
    }
    $('btnManualOk').addEventListener('click', manualSubmit);
    $('manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualSubmit(); });
    $('btnManualCancel').addEventListener('click', () => hideModal('manualModal'));

    // 缩略条收起
    $('thumbsToggle').addEventListener('click', () => {
      const collapsed = $('thumbsWrap').classList.toggle('collapsed');
      $('thumbsCaret').textContent = collapsed ? '▾' : '▴';
    });

    // 通用确认弹层
    $('confirmCancel').addEventListener('click', () => { hideModal('confirmModal'); pendingDeleteIndex = -1; });
    $('confirmOk').addEventListener('click', () => {
      hideModal('confirmModal');
      if (pendingDeleteIndex === -2) { restartScan(); }
      else if (pendingDeleteIndex >= 0) { doDelete(pendingDeleteIndex); }
      pendingDeleteIndex = -1;
    });

    // 音量键快门
    document.addEventListener('keydown', (e) => {
      if (anyModalOpen()) return;
      if (e.key === 'AudioVolumeDown' || e.key === 'AudioVolumeUp') { e.preventDefault(); shoot(); }
    });

    // 离开页面前提醒未上传
    window.addEventListener('beforeunload', (e) => {
      if (state.photos.some((p) => !p.uploaded)) { e.preventDefault(); e.returnValue = ''; }
    });

    // 切后台停止自动扫描，省电
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.scanning) stopScan();
    });
  }

  // ---------- 启动前恢复：跨刷新/关页保住未上传照片 ----------
  async function restoreFromDB() {
    if (!DB.available) return;
    try {
      const recs = await DB.getAll();
      const need = recs.filter((r) => !r.uploaded && r.blob);
      if (!need.length) return;
      need.forEach((r) => {
        const p = { blob: r.blob, url: URL.createObjectURL(r.blob), thumb: r.thumb || null, capturedAt: r.capturedAt, seq: r.seq, qr: r.qr, photographer: r.photographer, workstation: r.workstation, uploaded: r.uploaded || false, uploading: false, failed: false, dbId: r.id };
        state.photos.push(p);
        if (r.seq > state.seq) state.seq = r.seq;
      });
      renderThumbs();
      toast(`已恢复 ${need.length} 张未上传照片，可继续上传`);
      if (state.realtime) state.photos.forEach((p) => { if (!p.uploaded) uploadOne(p); });
    } catch (e) { /* 恢复失败不影响正常使用 */ }
  }

  // ---------- 启动 ----------
  bind();
  loadConfig();
  restoreFromDB();
  // PWA：注册 Service Worker（仅用于「可安装到主屏幕」，不缓存页面/脚本）
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  updateCodeChip();
  // v28：支持从任意原生扫码 App 经 URL 传入追溯码（无开发机也能用手机原生引擎扫码）
  // 配置扫码 App 的「扫描后打开网址」为 https://你的NAS:3000/?code=%s 即可，%s 会被替换为扫到的内容
  try {
    const _p = new URLSearchParams(location.search);
    const _code = (_p.get('code') || _p.get('qr') || '').trim();
    if (_code) { state.qr = _code; updateCodeChip(); toast('已从扫码 App 获取追溯码：' + _code); }
  } catch (e) {}
  $('photographer').value = state.photographer;
  $('btnWatermark').setAttribute('aria-checked', state.watermark ? 'true' : 'false');
  startCamera().catch((e) => {
    const tip = (e && e.name === 'NotAllowedError') ? '摄像头权限被拒绝，请在浏览器地址栏允许后重试'
      : (e && e.name === 'NotFoundError') ? '未检测到摄像头'
      : (e && e.name === 'TypeError') ? '无法访问摄像头：' + (e && e.message)
      : (e && e.message) || '无法访问摄像头';
    toast(tip);
  });
  if (!state.photographer) openWhoModal();
})();
