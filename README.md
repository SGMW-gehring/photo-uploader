# 照片追溯上传 · 原生 App（Capacitor 壳 + ML Kit 扫码）

把「扫码」交给手机原生引擎（安卓 ML Kit / iOS Vision，与 Google Lens、微信同款），
扫码结果回填到 NAS 上的 Web 上传页。识别率远高于浏览器 ZXing，**独立图标、可装到桌面**。

> 本工程只做「原生壳 + 原生扫码」。上传页 UI、水印、上传逻辑全部复用 NAS 上已有的 Web 服务，
> 改 UI 不用重新打包 App——只要在 NAS 上更新 Web 文件即可。

---

## 一、NAS 端要先改两处（一次性）

1. **更新 Web 文件**：把本包 `NAS_WEB_PATCH/` 里的 `app.js`、`index.html` 覆盖到
   `/vol1/1000/photo-uploader/public/`，然后飞牛 Docker **重建**该容器（前端烤进镜像，仅重启不生效）。
   - 这两个文件已加入「检测到 Capacitor 原生壳时，优先用原生引擎扫码」的逻辑。
2. **开启 App 直连模式**：在 docker-compose 的环境变量里加 `APP_HTTP=1`，让 3080 端口以 **HTTP 直接提供服务**
   （绕开 NAS 自签证书，否则手机原生 WebView 会被证书拦死）。改完**重建**容器。

验证：浏览器打开 `http://NAS的IP:3080` 能正常进上传页，即配置成功。

---

## 二、Android：GitHub Actions 云端出 APK（无需本机装任何开发环境）

1. 把本工程（`photo-uploader-app/` 整个目录）推到你的 **GitHub 仓库**（免费账号即可）。
2. 仓库里添加变量：
   - `Settings → Secrets and variables → Actions → Variables → New repository variable`
   - 名称 `CAP_NAS_URL`，值 `http://你的NAS的IP:3080`（例如 `http://192.168.1.50:3080`）
3. `Actions → Build Android APK → Run workflow`。
4. 构建完在 `Artifacts` 里下载 `photo-uploader-debug-apk`（debug 签名，个人侧载完全够用，免签名证书）。
5. 手机「设置 → 安全 → 安装未知应用」允许浏览器/文件管理器，点 APK 安装。桌面即出现「照片追溯上传」图标。

> 以后 Web 上传页改了，只在 NAS 上更新文件，**重装 App 不是必须**；只有改了原生扫码逻辑才需重新跑 Actions。

---

## 三、iOS：Codemagic 云端出 IPA + 侧载（需要 Apple ID）

iOS 没有「免电脑装真机」的通道，必须走这条路：

1. 注册 [codemagic.com](https://codemagic.io)（免费额度足够），关联你的 GitHub 仓库。
2. 在 Codemagic 关联你的 **Apple ID**（免费开发者账号即可；Personal Account → Integrations → Apple Developer Portal）。
3. 设置环境变量 `CAP_NAS_URL = http://你的NAS的IP:3080`，点 `Start new build`。
4. 下载构建出的 `*.ipa`。
5. 在**任意电脑**（Windows/Mac 都行）装 [Sideloadly](https://sideloadly.io) 或 [AltStore](https://altstore.io)，
   用你的 Apple ID 把 IPA 侧载到 iPhone。
   - 免费 Apple ID 签出的 App **每 7 天需重签一次**（Sideloadly 可一键重签，AltStore 在同源 WiFi 下可自动续期）。

> iOS 真机装包比安卓麻烦，这是 Apple 政策的硬限制，不是工程问题。若只想要「扫码识别率拉满」，
> 安卓 App 已完全满足；iOS 可用上一版的「快捷指令扫码 → 打开上传页」方案作为平替。

---

## 四、怎么工作的

- Capacitor 壳启动时加载 `http://NAS:3080`（由 `capacitor.config.ts` 的 `server.url` 决定）。
- 用户点「识别追溯码」时，`app.js` 检测到 `Capacitor.Plugins.BarcodeScanner` 存在，
  **直接调手机原生扫码 UI**（ML Kit / Vision），扫到后把码回填到追溯码框，流程继续走 Web 上传页。
- 扫码失败才会回退到浏览器解码流水线（兜底，不影响主路径）。

## 五、换图标（可选）

- Android：把图标放入 `android/app/src/main/res/mipmap-*` （`npx cap add android` 后生成），重跑 Actions。
- iOS：在 Xcode（或 Codemagic 构建后）替换 `ios/App/App/Assets.xcassets/AppIcon.appiconset`。
- 也可直接用在线工具（如 `appicon.co`）生成各尺寸后覆盖。

## 六、已知限制

- iOS 出包依赖 Apple ID + 侧载工具，免费账号 7 天重签。
- App 与 NAS 必须在同一局域网（或 NAS 可被手机路由访问）。
- `APP_HTTP=1` 下 3080 为明文 HTTP，仅建议局域网内使用；如需加密，后续可给 NAS 配受信任证书后改回 HTTPS。
