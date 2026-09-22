// 照片查询页：按追溯码(必)/日期区间/工位检索，缩略图网格 + 灯箱大图 + 整组 ZIP 下载。
(function () {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const grid = $('grid');
  const qrEl = $('qr'), fromEl = $('from'), toEl = $('to'), stationEl = $('station');
  const btnSearch = $('btnSearch'), btnZip = $('btnZip');

  function buildQuery(zip) {
    const p = new URLSearchParams();
    p.set('qr', qrEl.value.trim());
    if (fromEl.value) p.set('from', fromEl.value);
    if (toEl.value) p.set('to', toEl.value);
    if (stationEl.value.trim()) p.set('station', stationEl.value.trim());
    if (zip) p.set('zip', '1');
    return p;
  }

  async function search() {
    const qr = qrEl.value.trim();
    if (!qr) { statusEl.textContent = '请输入追溯码（可只输后 8 位）'; qrEl.focus(); return; }
    if (qr.length < 4) { statusEl.textContent = '至少输入后 4 位追溯码'; qrEl.focus(); return; }
    statusEl.textContent = '查询中…';
    grid.innerHTML = '';
    btnZip.style.display = 'none';
    try {
      const r = await fetch('/api/photos?' + buildQuery(false).toString(), { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) { statusEl.textContent = '查询失败：' + (d.error || r.status); return; }
      const items = d.items || [];
      if (!items.length) { grid.innerHTML = '<div class="g-empty">未找到匹配的照片</div>'; statusEl.textContent = '共 0 张'; return; }
      // 命中信息：后缀匹配时把实际匹配到的完整追溯码显示出来，便于核对
      let head = '共 ' + d.count + ' 张';
      if (d.fuzzy && d.matched === 1 && d.codes && d.codes[0]) {
        head += '（按后 ' + qr.length + ' 位匹配：' + d.codes[0] + '）';
      } else if (d.matched > 1) {
        head += '（命中 ' + d.matched + ' 个追溯码' + (d.codes && d.codes.length ? '：' + d.codes.join('、') : '') + '）';
      }
      statusEl.textContent = head +
        (d.truncated ? '（仅显示最近 ' + d.max + ' 张，请用日期/工位缩小范围）' : '');
      render(items);
      btnZip.style.display = '';
    } catch (e) {
      statusEl.textContent = '查询出错：' + e.message;
    }
  }

  // 单张原图下载：走 /api/photo?file=..&qr=..&download=1，服务端返回附件头。
  // 注意：不能用「程序合成 a.click()+download 属性」——夸克/微信X5/UC 等内核会静默拦截，
  // 表现就是点了没反应。改为直接跳转该 URL：服务端 attachment 头会让浏览器原地下载，不离开页面。
  function downloadOne(it) {
    const url = '/api/photo?file=' + encodeURIComponent(it.file) + '&qr=' + encodeURIComponent(it.qr) + '&download=1';
    window.location.href = url;
  }

  function render(items) {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'g-card';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.thumb ? it.thumb : it.url; // 优先缩略图，避免大图拖垮页面
      img.alt = it.name;
      const seq = document.createElement('div');
      seq.className = 'seq'; seq.textContent = '第' + it.seq + '张';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML =
        (it.capturedAt ? it.capturedAt + '<br>' : '') +
        (it.photographer ? '拍摄:' + it.photographer + '<br>' : '') +
        (it.station && it.station !== '-' ? '工位:' + it.station : '');
      // 单张原图下载按钮（不触发灯箱）
      const dl = document.createElement('button');
      dl.className = 'g-dl'; dl.textContent = '↓原图'; dl.title = '下载原图';
      dl.addEventListener('click', (e) => { e.stopPropagation(); downloadOne(it); });
      card.appendChild(img); card.appendChild(seq); card.appendChild(meta); card.appendChild(dl);
      card.addEventListener('click', () => openLightbox(it));
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function openLightbox(it) {
    $('lbImg').src = it.url;
    $('lbDl').href = '/api/photo?file=' + encodeURIComponent(it.file) + '&qr=' + encodeURIComponent(it.qr) + '&download=1';
    $('lbInfo').innerHTML =
      '<b>追溯码：</b>' + it.qr + '<br>' +
      '<b>拍摄时间：</b>' + (it.capturedAt || '—') + '<br>' +
      '<b>拍摄者：</b>' + (it.photographer || '—') + '（' + (it.shift || '') + '）<br>' +
      '<b>工位：</b>' + (it.station && it.station !== '-' ? it.station : '—') + '<br>' +
      '<b>序号：</b>第' + it.seq + '张 · ' + (it.size ? (it.size / 1024).toFixed(0) + ' KB' : '');
    $('lightbox').classList.remove('hidden');
  }

  function closeLightbox() { $('lightbox').classList.add('hidden'); }

  btnSearch.addEventListener('click', search);
  qrEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  stationEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  btnZip.addEventListener('click', () => {
    const qr = qrEl.value.trim();
    if (!qr) return;
    window.location.href = '/api/photos?' + buildQuery(true).toString();
  });
  $('lbClose').addEventListener('click', (e) => { e.preventDefault(); closeLightbox(); });
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
})();
