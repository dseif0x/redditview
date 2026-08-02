import { Platform } from 'react-native';
import { activeCookie, getSettings } from './settings';

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
  // Client-side: the `after` cursor that fetched this post, for resume.
  _cursor?: string;
};

export type FeedPage = { after: string; posts: Post[] };

// Mirrors backend/comments.go.
export type Comment = {
  id: string;
  author: string;
  body: string;
  score: number;
  scoreHidden: boolean;
  createdUtc: number;
  isSubmitter: boolean;
  distinguished?: string;
  stickied: boolean;
  replies?: Comment[];
  moreCount?: number;
};

export type CommentsPage = { comments: Comment[]; more: number };

export function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function apiBase(): string {
  return getSettings().serverUrl.trim().replace(/\/+$/, '');
}

// Backend API fetch: attaches the active account's reddit cookie, POSTs a
// JSON body when one is given, and turns error responses into thrown Errors.
// On web an empty server URL means same origin (the backend serving this
// app); native has no same-origin backend, so there the URL is required.
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const base = apiBase();
  if (!base && Platform.OS !== 'web') {
    throw new Error('Set your server URL in settings (gear icon) first.');
  }
  const cookie = activeCookie();
  const headers: Record<string, string> = {};
  if (cookie) headers['X-Reddit-Cookie'] = cookie;
  // Responses differ per account while sharing a URL; without this, iOS's
  // HTTP cache can serve another account's feed page after switching.
  let init: RequestInit = { headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' };
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
