// Cached-first access to the account's subscriptions (subscribed subreddits
// + followed users). Listing them walks reddit's paginated subscriber
// listing server-side, which can take a while — so the last result is kept
// in localStorage and served instantly, with a background refresh when it
// has gone stale.
//
// A completed refresh must reach open consumers, not just localStorage:
// serving stale-and-silently-updating left every reader permanently one
// refresh behind (a subreddit joined outside the app never showed up in
// the suggestion panel, however often it was opened). subsVersion bumps
// whenever the cached lists change; readers depend on it and re-pull.
//
// The cache lives under its OWN localStorage key, deliberately outside the
// settings object: it must never enter the encrypted sync blob (it is
// derived, per-account data the other device can fetch itself).
import { api } from './api.js';
import { settings } from './settings.svelte.js';

const CACHE_KEY = 'redditview.subscriptions';
const FRESH_MS = 5 * 60 * 1000; // serve cached instantly; refresh in background beyond this

// Bumped whenever the cached lists change (refresh landed, local patch).
// Reactive so a $effect that reads it re-runs — the suggestion panel
// re-pulls and shows the fresh lists while it is open.
const subs = $state({ version: 0 });
export const subsVersion = () => subs.version;

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

function writeCache(cached) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  subs.version++;
}

let inflight = null;

function refresh(fp) {
  if (!inflight) {
    inflight = (async () => {
      try {
        const data = await api('/api/subscriptions');
        writeCache({
          fp,
          fetchedAt: Date.now(),
          subreddits: data.subreddits || [],
          following: data.following || [],
          multis: data.multis || [],
        });
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
  writeCache(cached);
}

// Returns { subreddits, following, multis } — instantly from the cache
// when it matches the current account (kicking off a background refresh
// when stale; subsVersion announces its arrival), or from the network on a
// cache miss. Caches written before multis existed count as misses so the
// upgrade fills them in.
export async function getSubscriptions() {
  const fp = await cookieFingerprint();
  const cached = readCache();
  if (cached && cached.fp === fp && Array.isArray(cached.multis)) {
    if (Date.now() - (cached.fetchedAt || 0) > FRESH_MS) refresh(fp).catch(() => {});
    return {
      subreddits: cached.subreddits || [],
      following: cached.following || [],
      multis: cached.multis,
    };
  }
  return refresh(fp);
}
