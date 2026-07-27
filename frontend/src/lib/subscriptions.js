// Cached-first access to the account's subscriptions (subscribed subreddits
// + followed users). Listing them walks reddit's paginated subscriber
// listing server-side, which can take a while — so the last result is kept
// in localStorage and served instantly, with a background refresh when it
// has gone stale.
//
// The cache lives under its OWN localStorage key, deliberately outside the
// settings object: it must never enter the encrypted sync blob (it is
// derived, per-account data the other device can fetch itself).
import { api } from './api.js';
import { settings } from './settings.svelte.js';

const CACHE_KEY = 'redditview.subscriptions';
const FRESH_MS = 5 * 60 * 1000; // serve cached instantly; refresh in background beyond this

// The cache belongs to one reddit account; key it by a fingerprint of the
// cookie so switching accounts never shows another account's lists.
async function cookieFingerprint() {
  const cookie = settings.cookie.trim();
  if (!crypto?.subtle) return 'len:' + cookie.length;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookie));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {
    return null;
  }
}

let inflight = null;

function refresh(fp) {
  if (!inflight) {
    inflight = (async () => {
      try {
        const data = await api('/api/subscriptions');
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            fp,
            fetchedAt: Date.now(),
            subreddits: data.subreddits || [],
            following: data.following || [],
          })
        );
        return data;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

// Keep the cached lists in step after a follow/subscribe change without a
// refetch (the sheet that triggered the change was rendered from this cache,
// so it belongs to the current account).
export function patchSubscriptions(kind, name, on) {
  const cached = readCache();
  if (!cached) return;
  const key = kind === 'user' ? 'following' : 'subreddits';
  const list = (cached[key] || []).filter((n) => n.toLowerCase() !== name.toLowerCase());
  if (on) {
    list.push(name);
    list.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  }
  cached[key] = list;
  localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
}

// Returns { subreddits, following } — instantly from the cache when it
// matches the current account (kicking off a background refresh when
// stale), or from the network on a cache miss.
export async function getSubscriptions() {
  const fp = await cookieFingerprint();
  const cached = readCache();
  if (cached && cached.fp === fp) {
    if (Date.now() - (cached.fetchedAt || 0) > FRESH_MS) refresh(fp).catch(() => {});
    return { subreddits: cached.subreddits || [], following: cached.following || [] };
  }
  return refresh(fp);
}
