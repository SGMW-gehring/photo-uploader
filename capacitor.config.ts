import { CapacitorConfig } from '@capacitor/cli';

// NAS 地址：构建前用环境变量覆盖，例如
//   CAP_NAS_URL=http://192.168.1.50:3080 npx cap sync android
// 默认走 3080（需在 server.js 开启 APP_HTTP=1，以 HTTP 直连绕开自签证书）
const nas = process.env.CAP_NAS_URL || 'http://10.0.0.10:3080';

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return 'localhost'; }
}

const config: CapacitorConfig = {
  appId: 'com.fnnas.photouploader',
  appName: '照片追溯上传',
  webDir: 'www',
  // 远程加载 NAS 上的 Web 上传页；原生扫码由 @capacitor-mlkit/barcode-scanning 提供
  server: {
    url: nas,
    cleartext: true,        // 允许 http（3080 直连），Android 会设置 usesCleartextTraffic
    allowNavigation: [hostOf(nas)], // 仅放行 NAS 域名，Capacitor 桥接才生效
  },
  plugins: {
    // ML Kit 条码扫描：安卓走 Google ML Kit，iOS 走 Apple Vision
    BarcodeScanner: {},
  },
};

export default config;
