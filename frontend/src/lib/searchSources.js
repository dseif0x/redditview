// Sources for the feed input's suggestion panel. Each source is a
// self-contained provider so new kinds plug in by adding an entry here:
//
//   id          stable key
//   label       chip / section title
//   icon        Icon.svelte name for the chip and result rows
//   needsCookie gated behind a reddit cookie
//   empty       message when the source has no entries at all
//   items(q)    resolves to [{ label, path, sublabel?, applySort? }]
//   live        set true for query-driven sources (e.g. a future backend
//               subreddit/user search): they are re-called with the current
//               query (debounced by `debounce` ms, default 250) as the user
//               types, and their results are shown as-is. Sources without
//               `live` are fetched once per panel open with an empty query
//               and filtered client-side.
//
// Picking an item loads `path`; `applySort` (when present) replaces the
// active sort first — saved feeds remember the sort they were starred with.
import { settings } from './settings.svelte.js';
import { getSubscriptions } from './subscriptions.js';

export const SOURCES = [
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
];

export function matchesQuery(item, q) {
  if (!q) return true;
  return (
    item.label.toLowerCase().includes(q) || (item.sublabel || '').toLowerCase().includes(q)
  );
}
