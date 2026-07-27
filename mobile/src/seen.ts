import AsyncStorage from '@react-native-async-storage/async-storage';

// Seen-post tracking for the skip-seen option, ported from the web app.
// Insertion-ordered and capped so storage can't grow forever.

const KEY = 'redditview.seen';
const MAX = 5000;

let seen = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadSeen() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) seen = new Set(JSON.parse(raw));
  } catch {
    // corrupted -> start fresh
  }
}

export function isSeen(id: string): boolean {
  return seen.has(id);
}

export function markSeen(id: string) {
  if (!id || seen.has(id)) return;
  seen.add(id);
  if (seen.size > MAX) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  // Serializing thousands of ids isn't free; batch writes.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    AsyncStorage.setItem(KEY, JSON.stringify([...seen])).catch(() => {});
  }, 1500);
}
