// Sort handling, ported from the web frontend (frontend/src/main.js).
// A sort value is '' (default), a bare segment ('hot', 'new', ...), or
// 'top:week' style with a time range. Query strings are handled with local
// helpers — Hermes' URLSearchParams support is not dependable.

export const SORT_BASES = [
  { text: 'Default', value: '' },
  { text: 'Hot', value: 'hot' },
  { text: 'New', value: 'new' },
  { text: 'Rising', value: 'rising' },
  { text: 'Top…', value: 'top' },
  { text: 'Controversial…', value: 'controversial' },
];

export const SORT_TIMES = [
  { text: 'Past hour', value: 'hour' },
  { text: 'Past day', value: 'day' },
  { text: 'Past week', value: 'week' },
  { text: 'Past month', value: 'month' },
  { text: 'Past year', value: 'year' },
  { text: 'All time', value: 'all' },
];

const SORT_SEGMENTS = ['hot', 'new', 'rising', 'top', 'controversial', 'best'];

type Params = Array<[string, string]>;

function parseQuery(q: string): Params {
  const out: Params = [];
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    try {
      const k = decodeURIComponent(i >= 0 ? pair.slice(0, i) : pair);
      const v = i >= 0 ? decodeURIComponent(pair.slice(i + 1)) : '';
      out.push([k, v]);
    } catch {
      /* malformed escape -> drop the pair */
    }
  }
  return out;
}

function setParam(params: Params, key: string, value: string) {
  delParam(params, key);
  params.push([key, value]);
}

function delParam(params: Params, key: string) {
  for (let i = params.length - 1; i >= 0; i--) {
    if (params[i][0] === key) params.splice(i, 1);
  }
}

function encodeQuery(params: Params): string {
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// Rewrites the feed path for the selected sort mode: listing feeds
// (home/subreddit/multi) take the sort as a trailing path segment, user pages
// take ?sort=/&t= query params, and the per-user pseudo-feeds ignore it.
export function applySort(raw: string, sortValue: string): string {
  if (!sortValue) return raw;
  const [sort, t] = sortValue.split(':');

  // Strip scheme/host from pasted URLs so path logic below works.
  if (raw.includes('://')) {
    raw = raw.slice(raw.indexOf('://') + 3);
    const slash = raw.indexOf('/');
    raw = slash >= 0 ? raw.slice(slash + 1) : '';
  }
  const qi = raw.indexOf('?');
  const path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/^\/+|\/+$/g, '');
  const params = parseQuery(qi >= 0 ? raw.slice(qi + 1) : '');

  if (['saved', 'upvoted', 'downvoted', 'hidden'].includes(path)) return raw;

  if (t) setParam(params, 't', t);
  else delParam(params, 't');

  // User listing pages (not multireddits) sort via query params.
  if (/^(u|user)\/[^/]+(\/(submitted|posts|overview|comments|gilded))?$/i.test(path)) {
    setParam(params, 'sort', sort);
    return path + '?' + encodeQuery(params);
  }

  const parts = path.split('/').filter(Boolean);
  if (SORT_SEGMENTS.includes(parts[parts.length - 1])) parts.pop();
  parts.push(sort);
  const q = encodeQuery(params);
  return parts.join('/') + (q ? '?' + q : '');
}

export function sortLabel(s: string): string {
  if (!s) return 'Sort';
  const [b, t] = s.split(':');
  const cap = b.charAt(0).toUpperCase() + b.slice(1);
  return t ? `${cap} · ${t === 'all' ? 'all time' : t}` : cap;
}
