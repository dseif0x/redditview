import AsyncStorage from '@react-native-async-storage/async-storage';

// Device-local settings. The reddit cookie is stored like the web app stores
// it in localStorage: plaintext, on this device only, sent per request as the
// X-Reddit-Cookie header and never persisted server-side.
export type Settings = {
  serverUrl: string;
  cookie: string;
  feed: string;
};

const KEY = 'redditview.settings';
const DEFAULTS: Settings = { serverUrl: '', cookie: '', feed: '' };

let current: Settings = { ...DEFAULTS };

export function getSettings(): Settings {
  return current;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
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
