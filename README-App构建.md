# App 包构建说明（原生相机版 v33 / 最终版）

本目录是 **Android App 原生壳源码**，用于上传到你的 GitHub 仓库，由 GitHub Actions 云端构建出 APK。
**无需在本机装 Android SDK / Node 全量环境**——全在云端完成。

## 目录内容
```
App/
├── package.json              # 已加 @capacitor/camera（原生相机）
├── capacitor.config.ts       # 已加 Camera + BarcodeScanner 插件声明
├── tsconfig.json
├── .github/workflows/build-android.yml   # v33 构建流程（含相机权限硬校验）
├── www/index.html            # 启动页（填 NAS 地址、原生 ML Kit 扫码；v31 修复版）
└── NAS_WEB_PATCH/            # NAS 端 app.js 等，备查/离线部署用（不影响 App 构建）
```

## 构建步骤
1. **新建/复用**一个 GitHub 仓库（公开私有均可）。
2. 把本目录里的文件**按原结构上传/覆盖**到仓库根目录：
   - 根目录：`package.json`、`capacitor.config.ts`、`tsconfig.json`
   - `.github/workflows/build-android.yml`
   - `www/index.html`
   - （`NAS_WEB_PATCH/` 可一并上传，便于归档，不影响构建）
   > 注意 `.github` 是隐藏目录：用 GitHub 网页「Add file → Create new file」手动建路径 `.github/workflows/build-android.yml`，或一次性拖整个仓库文件夹（别只拖部分文件）。
3. push 到 `main` / `master` 分支（或手动在 Actions 点 `Run workflow`）。
4. 等待 `Build Android APK` 跑完（约 3–6 分钟）。
   - **必须看到日志** `✅ 相机权限已包含在 APK 中`；否则构建会标红（缺相机权限=哑包）。
5. 在 Actions 右侧 **Artifacts** 下载 `photo-uploader-debug-apk` → 解压得 `app-debug.apk`。

## 安装与验证
1. **先卸载手机上的旧 App**（避免版本混淆）。
2. 装 `app-debug.apk` → 「设置-应用信息」确认：版本 **3.0**、权限列表出现 **相机**。
3. 打开 App → 填/探测 `http://<NAS_IP>:3080` → 测试连接 → **开始扫码**（原生取景，对准条码自动跳上传页）。
4. 上传页点**拍照键** → 调起原生相机 → 拍完自动落库上传。
5. 查询输**后 8 位**追溯码命中。

## 说明
- App 不写死 NAS 地址：启动页运行时填，换 IP/网段不需要重新打包。
- 扫码走原生 ML Kit（不依赖 Google Play 服务）；拍照走原生 @capacitor/camera —— 二者都绕开了 3080 的 http 非安全源限制。
- 版本号固定在 3.0（workflow 自动改 `build.gradle`），装好后看到 3.0 即确认装的是新包。
