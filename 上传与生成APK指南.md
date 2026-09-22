# 上传工程 → GitHub Actions 自动生成 APK（保姆级）

沙箱无外网，无法本地编译。APK 由 GitHub 云端 runner 编译，步骤如下。

## 第 0 步：准备 GitHub 仓库
1. 打开 https://github.com → 右上角 + → New repository。
2. Repository name 填 `photo-uploader-app`，选 **Public**（私有也行，Actions 免费额度够用）。
3. 不要勾选 "Add a README"（我们工程自带），直接 Create repository。
4. 记下仓库地址，形如 `https://github.com/你的用户名/photo-uploader-app`。

## 第 1 步：把本工程上传到仓库
**推荐方式 A（最省事，不会丢隐藏文件）：GitHub Desktop**
1. 下载安装 GitHub Desktop（https://desktop.github.com）。
2. 登录你的账号 → File → Clone repository → 选 photo-uploader-app → Clone。
3. 把本 zip 解压得到的 `photo-uploader-app/` 文件夹里的**全部内容**复制进克隆出来的本地文件夹。
4. 左上角填个 Summary（如 "init"）→ Commit to main → Push origin。

**方式 B（纯网页，注意 .github 隐藏目录）：**
1. 在仓库页把下列“非隐藏文件”直接拖进网页上传：
   `capacitor.config.ts`、`package.json`、`tsconfig.json`、`.gitignore`、`README.md`、`codemagic.yaml`、`www/index.html`、`NAS_WEB_PATCH/`（整个文件夹）。
2. **关键**：网页拖拽会**跳过 `.github` 隐藏目录**，必须手动补：
   - 点 Add file → Create new file
   - 文件名填 `.github/workflows/build-android.yml`
   - 把工程里的 `build-android.yml.txt`（本指南同级）内容整段粘贴进去 → Commit。
   （没有这个文件，Actions 不会触发，白等。）

## 第 2 步：触发构建
- 上传完成后，GitHub 会自动开始构建（push 到 main/master 触发）。
- 也可手动：仓库页 → Actions → 左侧 "Build Android APK" → Run workflow。

## 第 3 步：下载 APK
- Actions 跑完（绿色 ✓，约 3-6 分钟）→ 右侧 Artifacts → `photo-uploader-debug-apk` → 下载解压得 `.apk`。
- 手机安装：安卓“设置 → 安全/应用 → 安装未知应用”对该浏览器/文件管理器放行，再点 apk 安装。

## 第 4 步：App 使用
1. 打开 App → 启动页自动探测上次地址。
2. 显示「已连接」→ 点「开始扫码」→ 对准条码 → 识别成功自动跳上传页并填好追溯码。
3. 连不上：点「自动探测」/「搜索本网段」，或手填 `http://NAS的IP:3080`。
> NAS 端需先按 README「一、NAS 端」开启 3080 直连（APP_HTTP=1）并部署 NAS_WEB_PATCH。
