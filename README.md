# 照片追溯上传 · 原生 App v2（Capacitor 壳 + ML Kit 扫码 + 运行时改地址）

把「扫码」交给手机原生引擎（ML Kit，与 Google Lens 同款），识别率远高于浏览器 ZXing；
上传页 UI、水印、上传逻辑全部复用 NAS 上已有的 Web 服务，**改 UI 不用重新打包 App**。

## v2 相比 v1 的改动（重要）

| 项目 | v1 | **v2** |
|---|---|---|
| NAS 地址 | 构建时写死进 APK | **App 内可随时改**（自动探测 / 搜索网段 / 手填），换 IP 不用重新打包 |
| 扫码入口 | 上传页里点「识别追溯码」 | **启动页点「开始扫码」**（原生 CameraX + ML Kit 本地模型） |
| Google 服务依赖 | 用插件现成扫码 UI（依赖 Google Play 服务，国产手机不可用） | **改用 `startScan`**，不依赖 Google Play 服务 |
| 相机权限 | 未声明（会失败） | 构建时自动写入 Manifest |

---

## 一、NAS 端（一次性）

1. **更新 Web 文件**：把 `NAS_WEB_PATCH/` 里的 `app.js`、`index.html` 覆盖到
   `/vol1/1000/photo-uploader/public/`，然后飞牛 Docker **重建**容器（前端烤进镜像，仅重启不生效）。
2. **开启 App 直连**：docker-compose 环境变量加 `APP_HTTP=1`，让 **3080 以 HTTP 直接提供服务**
   （绕开自签证书，否则原生 WebView 会被证书拦死）。改完**重建**容器。

验证：浏览器打开 `http://NAS的IP:3080` 能直接进上传页（不跳转到 3000）即成功。

---

## 二、Android：GitHub Actions 云端出 APK

1. 把本工程推到 GitHub 仓库（免费账号即可）。
2. `Actions → Build Android APK → Run workflow`（提交代码也会自动触发）。
3. 构建完在 `Artifacts` 下载 `photo-uploader-debug-apk`，解压得 APK，装到手机
   （需先在「设置 → 安装未知应用」放行）。

构建关键项（已在 workflow 里写好，别删）：
- Node **22**（Capacitor CLI 要求 ≥22）
- JDK **21**（Capacitor 8 安卓模块要求，用 17 会报 `invalid source release: 21`）
- 拷贝 ML Kit 插件浏览器脚本：`node_modules/@capacitor-mlkit/barcode-scanning/dist/plugin.js → www/mlkit-plugin.js`
- 注入相机权限到 `android/app/src/main/AndroidManifest.xml`

> 不需要任何 Secret/变量——地址在 App 里填。

---

## 三、iOS（可选）

Codemagic 云端出 IPA + Sideloadly/AltStore 侧载，免费 Apple ID 每 7 天重签一次。
若只追求扫码识别率，安卓 App 已完全够用；iOS 可用「快捷指令扫码 → 打开 `https://NAS:3000/?code=xxx`」平替。

---

## 四、App 使用方式

1. 打开 App → 启动页会**自动检测**上次保存的 NAS 地址。
2. 显示「已连接」→ 点 **开始扫码** → 相机打开，把条码放进取景框 → 识别成功**自动跳转上传页且追溯码已填好**。
3. 若显示不通：
   - 点 **自动探测**（试已保存过的所有地址）
   - 或点 **搜索本网段**（自动扫本机 /24 网段的 3080 端口，找出 NAS）
   - 或直接在地址栏手填 `http://NAS的IP:3080` 后点 **保存**
4. 扫码实在失败时，可在启动页**手动输入追溯码**打开上传页。

> 扫码请在**启动页**进行。若已进入上传页还想重新扫码，用手机返回键回到启动页即可。

---

## 五、怎么实现的（技术要点）

- **不再用 `server.url`**：App 加载本地 `www/index.html`（本地源带 Capacitor 桥接，ML Kit 可用）。
- `allowNavigation: ['*', '已知地址']`：`'*'` 让 WebView 能跳转任意运行时地址（Capacitor 用 HostMask，`*` 匹配任意 host）；
  显式列出的地址会额外获得桥接 JS 注入。
- `androidScheme: 'http'` + `allowMixedContent: true`：本地页访问 `http://NAS` 不被混合内容拦截。
- 扫码用 **ML Kit 的 `startScan`**（CameraX 预览置于 WebView 下方 + 本地模型），**不需要 Google Play 服务**；
  插件的 `scan()`（现成扫码界面）依赖 GMS，国产手机上不可用，已避开。
- 探测用 `fetch(mode:'no-cors')`：能发出请求即视为该地址有服务，规避跨域/证书干扰。

---

## 六、已知限制

- App 与 NAS 必须网络互通（同一 WiFi，或路由器放行）。
- `APP_HTTP=1` 下 3080 为明文 HTTP，建议仅局域网使用；后续可配受信任证书后改回 HTTPS。
- 改了 IP 后，上传页内不再有原生桥接（扫码走启动页即可），功能不受影响。
