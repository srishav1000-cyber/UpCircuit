// Human label for a push device from its user agent: "Windows · Chrome", "Android · Chrome", "iPhone · Home Screen PWA", …
export interface DeviceInfo { label: string; platform: string; mobile: boolean }
export function describeDevice(ua: string | undefined | null, standalone = false): DeviceInfo {
  const u = (ua ?? '').slice(0, 400);
  const platform = /iPhone/i.test(u) ? 'iPhone' : /iPad/i.test(u) ? 'iPad' : /Android/i.test(u) ? 'Android' : /Windows/i.test(u) ? 'Windows' : /Mac OS X|Macintosh/i.test(u) ? 'Mac' : /CrOS/i.test(u) ? 'ChromeOS' : /Linux|X11/i.test(u) ? 'Linux' : 'Device';
  const ios = platform === 'iPhone' || platform === 'iPad';
  const browser = /Edg(e|A|iOS)?\//i.test(u) ? 'Edge' : /OPR\/|Opera/i.test(u) ? 'Opera' : /SamsungBrowser/i.test(u) ? 'Samsung Internet' : /Firefox|FxiOS/i.test(u) ? 'Firefox' : /CriOS|Chrome\//i.test(u) ? 'Chrome' : /Safari\//i.test(u) ? 'Safari' : 'Browser';
  const how = ios && standalone ? 'Home Screen PWA' : standalone ? `${browser} (installed app)` : ios ? 'Safari' : browser;
  return { label: `${platform} · ${how}`, platform, mobile: ios || platform === 'Android' };
}
/** client side: is this page running as an installed PWA? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as { standalone?: boolean }).standalone === true;
}
