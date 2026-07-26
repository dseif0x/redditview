import { getSettings } from './settings';

// Mirrors the Post shape the Go backend serves (backend/feed.go).
export type Post = {
  id: string;
  name: string;
  likes: boolean | null;
  saved: boolean;
  title: string;
  author: string;
  subreddit: string;
  permalink: string;
  nsfw: boolean;
  numComments: number;
  kind: 'image' | 'gallery' | 'video' | 'text';
  images?: string[];
  videoHls?: string;
  videoMp4?: string;
  redgifsId?: string;
  redgifsMp4?: string;
  poster?: string;
  text?: string;
};

export type FeedPage = { after: string; posts: Post[] };

export function apiBase(): string {
  return getSettings().serverUrl.trim().replace(/\/+$/, '');
}

// Backend API fetch: attaches the reddit cookie, POSTs a JSON body when one
// is given, and turns error responses into thrown Errors.
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const base = apiBase();
  if (!base) throw new Error('Set your server URL in settings (gear icon) first.');
  const cookie = getSettings().cookie.trim();
  const headers: Record<string, string> = {};
  if (cookie) headers['X-Reddit-Cookie'] = cookie;
  let init: RequestInit = { headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(body) };
  }
  const res = await fetch(base + path, init);
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
  return res.json();
}

const PROXIED_HOSTS = ['redd.it', 'redditmedia.com', 'redditstatic.com', 'imgur.com', 'redgifs.com'];

// Hermes' URL support is incomplete; a regex keeps host extraction portable.
function hostOf(u: string): string {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(u);
  return m ? m[1].toLowerCase() : '';
}

// Route media through the backend proxy when it lives on a reddit/imgur CDN
// (hotlink protection + HLS rewriting); anything else loads directly.
export function mediaUrl(u: string): string {
  const host = hostOf(u);
  if (PROXIED_HOSTS.some((d) => host === d || host.endsWith('.' + d))) {
    return apiBase() + '/api/media?u=' + encodeURIComponent(u);
  }
  return u;
}
