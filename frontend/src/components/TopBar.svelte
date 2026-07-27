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
  import { getSubscriptions } from '../lib/subscriptions.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { presentActionSheet } from '../lib/sheet.svelte.js';
  import Icon from './Icon.svelte';

  let inputEl = $state(null);
  $effect(() => {
    registerFeedInput(inputEl);
  });

  const bookmarkIndex = $derived(settings.bookmarks.findIndex((b) => b.path === P.feedInput.trim()));
  const marked = $derived(bookmarkIndex >= 0);

  function bookmarkLabel(b) {
    const path = b.path || '(home)';
    return b.sort ? `${path} · ${b.sort.replace(':', ' ')}` : path;
  }

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

  // ---------------------------------------------------------------------------
  // Feeds menu: a two-level picker. Friends is reddit's built-in feed of
  // friended users' posts; Following and Subscribed come from the account's
  // subscriptions (reddit models "follow" as a u_<name> subscription); Saved
  // holds this app's bookmarked feeds.
  // ---------------------------------------------------------------------------
  function requireCookie() {
    if (!settings.cookie.trim()) {
      showToast('Set your reddit cookie in the Settings tab to use this feed');
      return false;
    }
    return true;
  }

  // The subscription-backed levels present immediately (spinner in the
  // sheet on a cache miss) and fill in from the cached-first loader.
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

  async function openFeedsMenu() {
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
    <button id="feeds-btn" class="pill" type="button" title="Feeds" onclick={openFeedsMenu}>
      Feeds
    </button>
    <button
      id="bm-btn"
      class="icon-btn"
      class:active={marked}
      type="button"
      title={marked ? 'Remove this feed from bookmarks' : 'Bookmark this feed'}
      onclick={toggleBookmark}
    >
      <Icon name="star" filled={marked} />
    </button>
    <button
      id="sort-btn"
      class:active={!!settings.sort}
      type="button"
      title="Sort"
      onclick={openSortPicker}
    >
      <span id="sort-label">{sortLabel(settings.sort)}</span>
      <Icon name="chevrons-up-down" />
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
