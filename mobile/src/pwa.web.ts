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
  link('manifest', '/manifest.webmanifest');
  link('apple-touch-icon', '/icons/apple-touch-icon.png');
  link('icon', '/icons/icon-192.png');

  const theme = document.createElement('meta');
  theme.name = 'theme-color';
  theme.content = '#0b0b0f';
  head.appendChild(theme);

  if ('serviceWorker' in navigator) {
    // This runs from a React effect, i.e. usually after the window load
    // event has already fired — register directly in that case.
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }
}
