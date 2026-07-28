// Sources for the feed input's suggestion panel. Each source is a
// self-contained provider so new kinds plug in by adding an entry here:
//
//   id          stable key
//   label       chip / section title
//   icon        Icon.svelte name for the chip and result rows
//   pinned      no chip; its items are the panel's initial view
//   needsCookie gated behind a reddit cookie
//   empty       message when the source has no entries at all
//   items(q)    resolves to [{ label, path, sublabel?, icon?, applySort? }]
//   live        set true for query-driven sources (like the reddit search):
//               they are re-called with the current query (debounced by
//               `debounce` ms, default 250) as the user types, and their
//               results are shown as-is. Sources without `live` are fetched
//               once per panel open with an empty query and filtered
//               client-side.
//   minQuery    live only: queries shorter than this show `empty` instead
//               of "no matches"
//
// Picking an item loads `path`; `applySort` (when present) replaces the
// active sort first — saved feeds remember the sort they were starred with.
import { settings } from './settings.svelte.js';
import { getSubscriptions } from './subscriptions.js';
import { api } from './api.js';

function fmtMembers(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M members';
  if (n >= 1000) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'K members';
  return n + ' members';
}

export const SOURCES = [
  {
    // Reddit's built-in listings, pinned: no chip — they ARE the panel's
    // initial view (and still match in cross-source search). Items carry
    // their own icons since each shortcut has its own identity.
    id: 'feeds',
    label: 'Feeds',
    icon: 'layers',
    pinned: true,
    needsCookie: true,
    empty: '',
    async items() {
      return [
        { label: 'Home', path: '', icon: 'home' },
        { label: 'Friends', path: 'r/friends', icon: 'heart' },
        { label: 'Saved posts', path: 'saved', icon: 'bookmark' },
        { label: 'Upvoted', path: 'upvoted', icon: 'arrow-big-up' },
        { label: 'Downvoted', path: 'downvoted', icon: 'arrow-big-down' },
        { label: 'Hidden', path: 'hidden', icon: 'eye-off' },
      ];
    },
  },
  {
    id: 'following',
    label: 'Followed',
    icon: 'users',
    needsCookie: true,
    empty: "This account doesn't follow any users yet",
    async items() {
      const users = (await getSubscriptions()).following || [];
      return users.map((u) => ({ label: 'u/' + u, path: `user/${u}/submitted` }));
    },
  },
  {
    id: 'subscribed',
    label: 'Subscribed',
    icon: 'newspaper',
    needsCookie: true,
    empty: "This account isn't subscribed to any subreddits yet",
    async items() {
      const subs = (await getSubscriptions()).subreddits || [];
      return subs.map((s) => ({ label: 'r/' + s, path: 'r/' + s }));
    },
  },
  {
    id: 'saved',
    label: 'Saved',
    icon: 'star',
    needsCookie: false,
    empty: 'No saved feeds yet — tap the star to save one',
    async items() {
      return settings.bookmarks.map((b) => ({
        label: b.path || '(home)',
        sublabel: b.sort ? b.sort.replace(':', ' ') : '',
        path: b.path,
        applySort: b.sort || '',
      }));
    },
  },
  {
    id: 'multis',
    label: 'Multis',
    icon: 'folder',
    needsCookie: true,
    empty: "This account doesn't have any multireddits yet",
    async items() {
      const multis = (await getSubscriptions()).multis || [];
      return multis.map((m) => ({
        label: m.name,
        path: m.path,
        sublabel: m.count ? m.count + ' subreddits' : '',
      }));
    },
  },
  {
    // Backend-backed reddit search: live sources are re-queried with the
    // typed text instead of being fetched once and filtered client-side.
    id: 'reddit',
    label: 'Reddit',
    icon: 'search',
    needsCookie: false,
    live: true,
    debounce: 300,
    minQuery: 2,
    empty: 'Type at least two characters to search all of reddit',
    async items(q) {
      q = q.trim();
      if (q.length < 2) return [];
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      return [
        ...(r.subreddits || []).map((s) => ({
          label: 'r/' + s.name,
          path: 'r/' + s.name,
          sublabel: fmtMembers(s.subscribers),
        })),
        ...(r.users || []).map((u) => ({ label: 'u/' + u, path: `user/${u}/submitted` })),
      ];
    },
  },
];

export function matchesQuery(item, q) {
  if (!q) return true;
  return (
    item.label.toLowerCase().includes(q) || (item.sublabel || '').toLowerCase().includes(q)
  );
}
