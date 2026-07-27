// Expo's static web export doesn't emit PWA plumbing, and without expo-router
// there's no HTML template to add tags to — so installability (manifest,
// icons, service worker; files in public/) is wired up at runtime instead.
export function initPWA() {
  const head = document.head;
  const link = (rel: string, href: string) => {
    const el = document.createElement('link');
    el.rel = rel;
    el.href = href;
    head.appendChild(el);
  };
  const meta = (name: string, content: string) => {
    const el = document.createElement('meta');
    el.name = name;
    el.content = content;
    head.appendChild(el);
  };
  link('manifest', '/manifest.webmanifest');
  link('apple-touch-icon', '/icons/apple-touch-icon.png');
  link('icon', '/icons/icon-192.png');
  meta('theme-color', '#0b0b0f');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  // Dark status bar over the app in standalone mode (applied when the PWA
  // is (re-)added to the home screen).
  meta('apple-mobile-web-app-status-bar-style', 'black-translucent');

  // The exported html/body are transparent (white behind the notch /
  // rubber-band overscroll) — paint them app-dark.
  document.documentElement.style.backgroundColor = '#0b0b0f';
  document.body.style.backgroundColor = '#0b0b0f';

  // Match the classic frontend's viewport: draw under the notch (also makes
  // env() safe-area insets real) and disable browser pinch-zoom — the app
  // pinch-zooms the post media itself.
  const viewport = document.querySelector('meta[name="viewport"]');
  viewport?.setAttribute(
    'content',
    'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no'
  );

  if ('serviceWorker' in navigator) {
    // This runs from a React effect, i.e. usually after the window load
    // event has already fired — register directly in that case.
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }
}
