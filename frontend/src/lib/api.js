import { settings } from './settings.svelte.js';

const PROXIED_HOSTS = ['redd.it', 'redditmedia.com', 'redditstatic.com', 'imgur.com', 'redgifs.com'];

// Base URL of the backend serving /api. Empty = same origin (the normal
// deployment); remote setups point it elsewhere via the server URL setting.
export function apiBase() {
  return String(settings.serverUrl || '')
    .trim()
    .replace(/\/+$/, '');
}

// Route media through the backend proxy when it lives on a reddit/imgur CDN
// (CORS + hotlinking); anything else loads directly.
export function mediaUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (PROXIED_HOSTS.some((d) => host === d || host.endsWith('.' + d))) {
      return apiBase() + '/api/media?u=' + encodeURIComponent(u);
    }
  } catch {
    /* relative or malformed -> use as-is */
  }
  return u;
}

// Backend API fetch: attaches the reddit cookie, POSTs a JSON body when one
// is given, and turns error responses into thrown Errors.
export async function api(url, body) {
  const base = apiBase();
  const headers = {};
  if (settings.cookie.trim()) headers['X-Reddit-Cookie'] = settings.cookie.trim();
  // Responses differ per account while sharing a URL; without this, WebKit's
  // HTTP cache can serve another account's feed page after switching.
  let init = { headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' };
  }
  const res = await fetch(base + url, init);
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
  return res.json();
}
