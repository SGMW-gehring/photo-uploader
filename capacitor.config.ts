import { CapacitorConfig } from '@capacitor/cli';

// 说明（重要）：
// 本 App 不再把 NAS 地址写死进安装包。启动页（www/index.html）由 App 本地加载，
// 用户在 App 内填写/探测 NAS 地址，运行时跳转过去 —— 以后换 IP、加网段都不用重新打包。
//
// 关键点：
// - 不设 server.url：加载本地 www（本地源才带 Capacitor 桥接，ML Kit 插件可用）
// - allowNavigation: ['*']：允许 WebView 内跳转到任意 NAS 地址（Capacitor 用 HostMask，"*" 匹配任意 host）
// - androidScheme 'http' + allowMixedContent：本地页访问 http://NAS 不会被混合内容拦截
const config: CapacitorConfig = {
  appId: 'com.fnnas.photouploader',
  appName: '照片追溯上传',
  webDir: 'www',
  server: {
    androidScheme: 'http',
    cleartext: true, // 允许 http（3080 直连），Android 会设置 usesCleartextTraffic
    // '*' 让 WebView 能跳转到运行时的任意 NAS 地址；
    // 再显式列出已知地址，Capacitor 才会把桥接 JS 注入该页面（上传页内也能直接用原生扫码）
    allowNavigation: ['*', '192.168.31.10:3080'],
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    // ML Kit 条码扫描：App 本地页调用 startScan（CameraX + ML Kit 本地模型，不依赖 Google Play 服务）
    BarcodeScanner: {},
    // 原生相机：上传页拍照走原生通道，绕过 WebView 在非安全源(http 3080)下禁用网页相机的限制
    Camera: {},
  },
};

export default config;
