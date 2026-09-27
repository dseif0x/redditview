// Reddit URLs the app can show itself. Links in comments, captions and
// link posts (and the app's own URL when it is opened at a reddit-shaped
// path) are classified into either a feed the player can start or a single
// post it can show — everything else (wiki pages, modmail, search…) stays an
// ordinary external link.
//
// Results: { kind: 'feed', path } | { kind: 'post', path, comment } | null.
// `path` is what goes to /api/feed; for posts that is the permalink minus
// slug and comment id ("r/pics/comments/abc123"), or the share link itself
// ("r/pics/s/XyZ", which the backend resolves).

const REDDIT_HOST = /^(?:[a-z0-9-]+\.)*reddit\.com$/i; // www, old, new, np, sh, amp, m…
const ID = /^[a-z0-9]+$/i;
const SORTS = new Set(['hot', 'new', 'rising', 'top', 'controversial', 'best']);
const USER_LISTINGS = new Set(['submitted', 'posts', 'overview']);

// A feed path that shows exactly one post (a permalink or a share link):
// the player skips its listing filters (seen, kind) for these — the user
// asked for THIS post — and the sort selector leaves them alone.
export function isPostPath(path) {
  return /(^|\/)comments\/[a-z0-9]+(\/|$)/i.test(path) || /^r\/[^/]+\/s\/[a-z0-9]+\/?$/i.test(path);
}

// The post id inside a permalink-style path, or ''.
export function postIdOf(path) {
  return (/(?:^|\/)comments\/([a-z0-9]+)(?:\/|$)/i.exec(path) || [])[1]?.toLowerCase() || '';
}

function feed(path, params) {
  const t = params?.get('t');
  return { kind: 'feed', path: t && /^(hour|day|week|month|year|all)$/.test(t) ? `${path}?t=${t}` : path };
}

function post(path, comment = '') {
  return { kind: 'post', path, comment: comment.toLowerCase() };
}

// Classify a reddit-site path ("/r/pics/comments/abc/slug/", "/u/name"…).
export function parseRedditPath(pathname, search = '') {
  const segs = pathname.split('/').filter(Boolean).map(decodeURIComponentSafe);
  const params = new URLSearchParams(search);
  const lower = segs.map((s) => s.toLowerCase());

  if (segs.length === 0) return feed('', null); // reddit.com itself: the home feed

  // Post permalinks: [r/<sub>|user/<name>]/comments/<id>[/<slug>[/<comment>]]
  const ci = lower.indexOf('comments');
  if (ci >= 0 && ci <= 2 && ID.test(segs[ci + 1] || '')) {
    const prefix = segs.slice(0, ci);
    if (prefix.length === 0 || (prefix.length === 2 && /^(r|u|user)$/i.test(prefix[0]))) {
      const id = segs[ci + 1].toLowerCase();
      const comment = ID.test(segs[ci + 3] || '') ? segs[ci + 3] : '';
      const base = prefix.length ? `${prefix[0].toLowerCase() === 'r' ? 'r' : 'user'}/${prefix[1]}/` : '';
      return post(`${base}comments/${id}`, comment);
    }
  }

  switch (lower[0]) {
    case 'r': {
      const sub = segs[1];
      if (!sub) return null;
      if (segs.length === 2) return feed(`r/${sub}`, params);
      if (segs.length === 3 && SORTS.has(lower[2])) return feed(`r/${sub}/${lower[2]}`, params);
      if (lower[2] === 's' && ID.test(segs[3] || '')) return post(`r/${sub}/s/${segs[3]}`); // share link
      return null; // wiki, about, search, submit, rules…
    }
    case 'u':
    case 'user': {
      const name = segs[1];
      if (!name) return null;
      if (segs.length === 2) return feed(`user/${name}/submitted`, params);
      if (segs.length === 3 && USER_LISTINGS.has(lower[2])) return feed(`user/${name}/${lower[2]}`, params);
      if (lower[2] === 'm' && segs[3]) {
        if (segs.length === 4) return feed(`user/${name}/m/${segs[3]}`, params);
        if (segs.length === 5 && SORTS.has(lower[4])) return feed(`user/${name}/m/${segs[3]}/${lower[4]}`, params);
      }
      return null;
    }
    case 'gallery':
    case 'video':
    case 'tb':
      // Media-first post URLs (reddit.com/gallery/<id>) are post permalinks.
      return ID.test(segs[1] || '') && segs.length === 2 ? post(`comments/${segs[1].toLowerCase()}`) : null;
    default:
      return SORTS.has(lower[0]) && segs.length === 1 ? feed(lower[0], params) : null;
  }
}

// Classify an absolute URL (or one relative to `base`); null for anything
// that isn't a reddit page the app can show.
export function parseRedditLink(href, base = undefined) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'redd.it') {
    // Short links carry the post id itself.
    const m = /^\/([a-z0-9]+)\/?$/i.exec(u.pathname);
    return m ? post(`comments/${m[1].toLowerCase()}`) : null;
  }
  if (!REDDIT_HOST.test(host)) return null;
  return parseRedditPath(u.pathname, u.search);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
