// The Feeds menu: a two-level picker opened from the tab bar. Friends is
// reddit's built-in feed of friended users' posts; Following and Subscribed
// come from the account's subscriptions (reddit models "follow" as a
// u_<name> subscription); Saved holds this app's bookmarked feeds.
import { goToFeed } from './player.svelte.js';
import { settings, saveSettings } from './settings.svelte.js';
import { getSubscriptions } from './subscriptions.js';
import { presentActionSheet } from './sheet.svelte.js';
import { showToast } from './toast.svelte.js';

function requireCookie() {
  if (!settings.cookie.trim()) {
    showToast('Set your reddit cookie in the Settings tab to use this feed');
    return false;
  }
  return true;
}

function bookmarkLabel(b) {
  const path = b.path || '(home)';
  return b.sort ? `${path} · ${b.sort.replace(':', ' ')}` : path;
}

async function openSavedFeeds() {
  if (settings.bookmarks.length === 0) {
    showToast('No saved feeds yet — tap the star to bookmark the current feed', 3000);
    return;
  }
  const options = settings.bookmarks.map((b, i) => ({ text: bookmarkLabel(b), value: String(i) }));
  const v = await presentActionSheet('Saved feeds', options);
  if (v === undefined) return;
  const b = settings.bookmarks[Number(v)];
  if (!b) return;
  settings.sort = b.sort || '';
  saveSettings();
  goToFeed(b.path);
}

// The subscription-backed levels present immediately (spinner in the sheet
// on a cache miss) and fill in from the cached-first loader.
async function openFollowing() {
  if (!requireCookie()) return;
  let users = [];
  const v = await presentActionSheet(
    'Following',
    (async () => {
      try {
        users = (await getSubscriptions()).following || [];
      } catch (err) {
        showToast('Could not load subscriptions: ' + (err.message || err));
        return null;
      }
      if (users.length === 0) {
        showToast("This account doesn't follow any users yet");
        return null;
      }
      return [
        { text: 'All following', value: '*' },
        ...users.map((u) => ({ text: 'u/' + u, value: u })),
      ];
    })()
  );
  if (v === undefined) return;
  if (v === '*') goToFeed('r/' + users.map((u) => 'u_' + u).join('+'));
  else goToFeed(`user/${v}/submitted`);
}

async function openSubscribed() {
  if (!requireCookie()) return;
  let subreddits = [];
  const v = await presentActionSheet(
    'Subscribed',
    (async () => {
      try {
        subreddits = (await getSubscriptions()).subreddits || [];
      } catch (err) {
        showToast('Could not load subscriptions: ' + (err.message || err));
        return null;
      }
      if (subreddits.length === 0) {
        showToast("This account isn't subscribed to any subreddits yet");
        return null;
      }
      return [
        { text: 'All subscribed', value: '*' },
        ...subreddits.map((s) => ({ text: 'r/' + s, value: s })),
      ];
    })()
  );
  if (v === undefined) return;
  if (v === '*') goToFeed('r/' + subreddits.join('+'));
  else goToFeed('r/' + v);
}

export async function openFeedsMenu() {
  const v = await presentActionSheet('Feeds', [
    { text: 'Friends', value: 'friends' },
    { text: 'Following…', value: 'following' },
    { text: 'Subscribed…', value: 'subscribed' },
    { text: 'Saved…', value: 'saved' },
  ]);
  if (v === 'friends') {
    if (requireCookie()) goToFeed('r/friends');
  } else if (v === 'following') {
    openFollowing();
  } else if (v === 'subscribed') {
    openSubscribed();
  } else if (v === 'saved') {
    openSavedFeeds();
  }
}
