// ---------------------------------------------------------------------------
// Settings (localStorage only), as reactive Svelte state.
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'redditview.settings';
export const DEFAULTS = {
  serverUrl: '',
  cookie: '',
  accounts: [],
  activeAccount: 0,
  imageSeconds: 8,
  preloadCount: 1, // posts mounted (and loading) ahead of the current one
  autoscroll: false,
  lastFeed: '',
  showImages: true,
  showVideos: true,
  showText: true,
  fillScreen: false,
  vertical: false,
  smoothScroll: true,
  showPauseIcon: true,
  // Progress bar position: bottom | top | left | right | auto (tap near a
  // screen edge to dock it there). barPos remembers auto's last dock.
  barMode: 'bottom',
  barPos: 'bottom',
  barInvert: false,
  sort: '',
  bookmarks: [],
  skipSeen: false,
  debug: false,
};

// Migrations that must see the RAW stored object (before DEFAULTS fill in
// missing keys). Also applied to imported/synced settings from older builds.
function migrateStored(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // The movable-bar boolean became the barMode select.
  if (raw.barMode === undefined && raw.moveBar !== undefined) {
    raw.barMode = raw.moveBar ? 'auto' : 'bottom';
  }
  delete raw.moveBar;
  return raw;
}

function loadSettings() {
  let s = { ...DEFAULTS };
  try {
    s = { ...DEFAULTS, ...migrateStored(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) };
  } catch {
    /* corrupted storage -> defaults */
  }

  // Migrate the old audio-debug setting into the general debug setting.
  if (s.audioDebug) s.debug = true;
  delete s.audioDebug;

  // Migrate the old start-muted setting into the play-audio setting.
  delete s.audioOn; // sessions now always start muted
  delete s.startMuted;

  // Migrate a pre-accounts cookie into the account list.
  if (!Array.isArray(s.accounts)) s.accounts = [];
  if (s.accounts.length === 0 && s.cookie) {
    s.accounts = [{ name: 'Account 1', cookie: s.cookie }];
    s.activeAccount = 0;
  }
  return s;
}

export const settings = $state(loadSettings());

export function activeCookie() {
  const a = settings.accounts[settings.activeAccount];
  return a ? a.cookie.trim() : '';
}
settings.cookie = activeCookie();

// Cheap stable signature of a cookie (djb2), for tagging resume/history
// positions with the account they were browsed with — a cursor from another
// account's session must not be resumed into its feed.
export function cookieSig(cookie) {
  let h = 5381;
  for (let i = 0; i < cookie.length; i++) h = ((h * 33) ^ cookie.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Sync integration: the sync module registers a hook that schedules an
// upload after local changes, and flips `applyingRemote` while it applies a
// downloaded snapshot so those writes don't count as local edits (or loop
// back into another upload).
let changeHook = null;
let applyingRemote = false;
const UPDATED_KEY = 'redditview.updatedAt';

export function setSettingsChangeHook(fn) {
  changeHook = fn;
}

export function localUpdatedAt() {
  return Number(localStorage.getItem(UPDATED_KEY) || 0);
}

export function withRemoteApply(fn) {
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = false;
  }
}

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify($state.snapshot(settings)));
  if (!applyingRemote) {
    localStorage.setItem(UPDATED_KEY, String(Date.now()));
    changeHook?.();
  }
}

// Wholesale replacement (settings import): validates shape like the original.
export function replaceSettings(parsed) {
  const next = { ...DEFAULTS, ...migrateStored(parsed) };
  if (!Array.isArray(next.accounts)) next.accounts = [];
  if (!Array.isArray(next.bookmarks)) next.bookmarks = [];
  if (typeof next.activeAccount !== 'number' || !next.accounts[next.activeAccount]) {
    next.activeAccount = 0;
  }
  // Drop keys the import doesn't carry, then apply the new ones in place so
  // every reader of `settings` sees the imported values.
  for (const key of Object.keys(settings)) {
    if (!(key in next)) delete settings[key];
  }
  Object.assign(settings, next);
  settings.cookie = activeCookie();
  saveSettings();
}

// ---------------------------------------------------------------------------
// Seen-post tracking for the skip-seen option. Insertion-ordered and capped
// so storage can't grow forever.
// ---------------------------------------------------------------------------
const SEEN_KEY = 'redditview.seen';
const SEEN_MAX = 5000;
let seenIds = new Set();
try {
  seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
} catch {
  /* corrupted -> start fresh */
}

export function hasSeen(id) {
  return seenIds.has(id);
}

let seenSaveTimer = null;
export function markSeen(id) {
  if (!id || seenIds.has(id)) return;
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) {
    seenIds.delete(seenIds.values().next().value); // drop the oldest
  }
  clearTimeout(seenSaveTimer);
  // Serializing thousands of ids isn't free; write when the thread is idle.
  seenSaveTimer = setTimeout(() => {
    (window.requestIdleCallback || setTimeout)(() => localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds])));
  }, 1500);
  changeHook?.();
}

export function seenList() {
  return [...seenIds];
}

// Union-merge remote seen ids in (remote first so local recency survives the
// insertion-order cap), then persist.
export function mergeSeen(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const merged = new Set(ids);
  for (const id of seenIds) merged.add(id);
  while (merged.size > SEEN_MAX) merged.delete(merged.values().next().value);
  seenIds = merged;
  (window.requestIdleCallback || setTimeout)(() => localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds])));
}
