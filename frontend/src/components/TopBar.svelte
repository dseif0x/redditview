<script>
  import {
    P,
    goToFeed,
    toggleAutoscroll,
    toggleMute,
    toggleFill,
    openSortPicker,
    sortLabel,
    registerFeedInput,
  } from '../lib/player.svelte.js';
  import { settings, saveSettings } from '../lib/settings.svelte.js';
  import { getSubscriptions, patchSubscriptions } from '../lib/subscriptions.js';
  import { api } from '../lib/api.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { presentActionSheet } from '../lib/sheet.svelte.js';
  import Icon from './Icon.svelte';

  let inputEl = $state(null);
  $effect(() => {
    registerFeedInput(inputEl);
  });

  const bookmarkIndex = $derived(settings.bookmarks.findIndex((b) => b.path === P.feedInput.trim()));
  const marked = $derived(bookmarkIndex >= 0);

  // Feed bookmarks: star the current feed (with its sort) and re-open it
  // from the quick-pick sheet.
  function toggleBookmark() {
    if (bookmarkIndex >= 0) {
      settings.bookmarks.splice(bookmarkIndex, 1);
      showToast('Bookmark removed', 1500);
    } else {
      settings.bookmarks.push({ path: P.feedInput.trim(), sort: settings.sort });
      showToast('Feed bookmarked', 1500);
    }
    saveSettings();
  }

  // A user-profile or single-subreddit feed the save button can act on
  // beyond bookmarking (follow the user / subscribe to the subreddit).
  function feedTarget(path) {
    let m = /^(?:u|user)\/([^/+]+?)(?:\/(?:submitted|posts|overview|comments|gilded))?$/i.exec(path);
    if (!m) m = /^r\/u_([^/+]+)$/i.exec(path); // r/u_name IS a user profile
    if (m) return { kind: 'user', name: m[1] };
    const s = /^r\/([A-Za-z0-9][A-Za-z0-9_]*)$/i.exec(path);
    if (s && !['all', 'popular', 'friends', 'mod'].includes(s[1].toLowerCase())) {
      return { kind: 'subreddit', name: s[1] };
    }
    return null;
  }

  // The save button: on a user or subreddit feed (with a cookie) it opens a
  // chooser — save/unsave the feed locally, or follow/unfollow the user
  // (subscribe/unsubscribe the subreddit) on reddit. Every option flips to
  // its opposite when already active. Elsewhere it stays the plain
  // one-tap bookmark toggle.
  async function onSaveButton() {
    const target = feedTarget(P.feedInput.trim());
    if (!target || !settings.cookie.trim()) {
      toggleBookmark();
      return;
    }
    const label = (target.kind === 'user' ? 'u/' : 'r/') + target.name;
    let active = false; // currently following / subscribed
    const v = await presentActionSheet(
      label,
      (async () => {
        try {
          const subs = await getSubscriptions();
          const list = target.kind === 'user' ? subs.following : subs.subreddits;
          active = (list || []).some((n) => n.toLowerCase() === target.name.toLowerCase());
        } catch {
          /* state unknown; offer the positive action */
        }
        const redditText =
          target.kind === 'user'
            ? (active ? 'Unfollow ' : 'Follow ') + label
            : (active ? 'Unsubscribe from ' : 'Subscribe to ') + label;
        return [
          { text: bookmarkIndex >= 0 ? 'Remove saved feed' : 'Save feed', value: 'save' },
          { text: redditText, value: 'reddit' },
        ];
      })()
    );
    if (v === 'save') {
      toggleBookmark();
    } else if (v === 'reddit') {
      const srName = target.kind === 'user' ? 'u_' + target.name : target.name;
      try {
        await api('/api/subscribe', { name: srName, subscribe: !active });
        patchSubscriptions(target.kind, target.name, !active);
        showToast(
          target.kind === 'user'
            ? (active ? 'Unfollowed ' : 'Following ') + label
            : (active ? 'Unsubscribed from ' : 'Subscribed to ') + label,
          2000
        );
      } catch (err) {
        showToast('Failed: ' + (err.message || err));
      }
    }
  }

  function submit(e) {
    e.preventDefault();
    inputEl?.blur();
    goToFeed(P.feedInput.trim());
  }
</script>

<header id="topbar">
  <form id="feed-form" onsubmit={submit}>
    <input
      id="feed-input"
      bind:this={inputEl}
      bind:value={P.feedInput}
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="r/pics · user/name/m/multi · saved · upvoted · empty = home"
    />
    <button id="go-btn" class="btn-solid" type="submit" title="Load feed">Go</button>
  </form>
  <div id="feed-tools">
    <button
      id="bm-btn"
      class="icon-btn"
      class:active={marked}
      type="button"
      title={marked ? 'Remove this feed from bookmarks' : 'Save this feed'}
      onclick={onSaveButton}
    >
      <Icon name="star" filled={marked} />
    </button>
    <button
      id="sort-btn"
      class="icon-btn"
      class:active={!!settings.sort}
      type="button"
      title="Sort: {sortLabel(settings.sort)}"
      onclick={openSortPicker}
    >
      <Icon name="sort" />
    </button>
  </div>
  <div class="controls">
    <button
      id="fill-btn"
      class="icon-btn"
      class:active={settings.fillScreen}
      type="button"
      title="Fill screen (f)"
      onclick={toggleFill}
    >
      <Icon name="expand" />
    </button>
    <button
      id="pause-btn"
      class="icon-btn"
      class:active={settings.autoscroll}
      type="button"
      title={settings.autoscroll
        ? 'Autoscroll on — click to stop (space)'
        : 'Autoscroll off — click to start (space)'}
      onclick={toggleAutoscroll}
    >
      <Icon name={settings.autoscroll ? 'pause' : 'play'} />
    </button>
    <button
      id="mute-btn"
      class="icon-btn"
      class:active={!P.muted}
      type="button"
      title={P.muted ? 'Audio off — click to play audio (m)' : 'Audio on — click to mute (m)'}
      onclick={toggleMute}
    >
      <Icon name={P.muted ? 'volume-off' : 'volume-on'} />
    </button>
  </div>
</header>
