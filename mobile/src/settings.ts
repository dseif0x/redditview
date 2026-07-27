import AsyncStorage from '@react-native-async-storage/async-storage';

// Device-local settings, mirroring the web frontend's feature set. The
// reddit cookie is stored like the web app stores it in localStorage:
// plaintext, on this device only, sent per request as the X-Reddit-Cookie
// header and never persisted server-side.

export type Account = { name: string; cookie: string };
export type Bookmark = { path: string; sort: string };
export type Resume = { path: string; sort: string; cursor: string; name: string };
export type BarPos = 'bottom' | 'top' | 'left' | 'right';
// 'auto' = the web app's movable-bar mode: tapping near a screen edge docks
// the bar there; the docked position lives in barAutoPos.
export type BarPosSetting = BarPos | 'auto';

export type Settings = {
  serverUrl: string;
  accounts: Account[];
  activeAccount: number;
  feed: string;
  sort: string;
  bookmarks: Bookmark[];
  imageSeconds: number;
  autoscroll: boolean;
  fillScreen: boolean;
  vertical: boolean;
  showPauseIcon: boolean;
  barPos: BarPosSetting;
  barAutoPos: BarPos;
  barInvert: boolean;
  showImages: boolean;
  showVideos: boolean;
  showText: boolean;
  skipSeen: boolean;
  muted: boolean;
  resume: Resume | null;
};

const KEY = 'redditview.settings';

export const DEFAULTS: Settings = {
  serverUrl: '',
  accounts: [],
  activeAccount: 0,
  feed: '',
  sort: '',
  bookmarks: [],
  imageSeconds: 8,
  autoscroll: false,
  fillScreen: false,
  vertical: true, // TikTok-style by default on mobile; the web app defaults horizontal
  showPauseIcon: true,
  barPos: 'bottom',
  barAutoPos: 'bottom',
  barInvert: false,
  showImages: true,
  showVideos: true,
  showText: true,
  skipSeen: false,
  muted: true,
  resume: null,
};

let current: Settings = { ...DEFAULTS };

function sanitize(raw: Partial<Settings> & { cookie?: string }): Settings {
  const s: Settings = { ...DEFAULTS, ...raw };
  if (!Array.isArray(s.accounts)) s.accounts = [];
  s.accounts = s.accounts
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ name: String(a.name || `Account ${i + 1}`), cookie: String(a.cookie || '') }));
  // Migrate the spike's single-cookie shape into the account list.
  if (s.accounts.length === 0 && typeof raw.cookie === 'string' && raw.cookie.trim()) {
    s.accounts = [{ name: 'Account 1', cookie: raw.cookie }];
    s.activeAccount = 0;
  }
  if (typeof s.activeAccount !== 'number' || !s.accounts[s.activeAccount]) s.activeAccount = 0;
  if (!Array.isArray(s.bookmarks)) s.bookmarks = [];
  s.bookmarks = s.bookmarks
    .filter((b) => b && typeof b === 'object' && typeof b.path === 'string')
    .map((b) => ({ path: b.path, sort: String(b.sort || '') }));
  s.imageSeconds = Math.max(1, Number(s.imageSeconds) || DEFAULTS.imageSeconds);
  if (!['bottom', 'top', 'left', 'right', 'auto'].includes(s.barPos)) s.barPos = 'bottom';
  if (!['bottom', 'top', 'left', 'right'].includes(s.barAutoPos)) s.barAutoPos = 'bottom';
  if (s.resume && (typeof s.resume !== 'object' || typeof s.resume.path !== 'string' || !s.resume.name)) {
    s.resume = null;
  }
  return s;
}

export function getSettings(): Settings {
  return current;
}

export function activeCookie(): string {
  const a = current.accounts[current.activeAccount];
  return a ? a.cookie.trim() : '';
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) current = sanitize(JSON.parse(raw));
  } catch {
    // corrupted storage -> defaults
  }
  return current;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
  return current;
}

// Replace everything (settings import). Returns the sanitized result.
export function replaceSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('That does not look like exported settings');
  }
  current = sanitize(raw as Partial<Settings>);
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
  return current;
}
