<script>
  import {
    P,
    goToFeed,
    vote,
    toggleSave,
    openComments,
    viewerTouchStart,
    viewerTouchMove,
    viewerTouchEnd,
    viewerPointerDown,
    recentDragEnd,
  } from '../lib/player.svelte.js';
  import { showToast } from '../lib/toast.svelte.js';
  import Icon from './Icon.svelte';

  const post = $derived(!P.message && P.idx >= 0 ? P.posts[P.idx] : null);

  let titleEl = $state(null);
  let expanded = $state(false);
  let truncatable = $state(false);

  // Only clamped titles get the pointer affordance; re-measure per post.
  $effect(() => {
    void post?.title;
    expanded = false;
    const el = titleEl;
    if (!el) return;
    requestAnimationFrame(() => {
      truncatable = el.scrollHeight > el.clientHeight + 1;
    });
  });

  function feedLink(e, feed) {
    e.preventDefault();
    if (recentDragEnd()) return; // the click is a mouse drag's residue, not a tap
    goToFeed(feed);
  }

  // Native share sheet with the post's reddit link; clipboard fallback
  // where Web Share isn't available (desktop browsers).
  async function sharePost() {
    if (!post) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, url: post.permalink });
      } else {
        await navigator.clipboard.writeText(post.permalink);
        showToast('Link copied', 1500);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') showToast('Could not share'); // dismissing the sheet is not an error
    }
  }

  // Instagram-style compact counts under the action icons.
  function fmtCount(n) {
    if (n == null) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return String(n);
  }
</script>

{#if post}
  <footer id="meta">
    <!-- The caption block sits above #viewer, so its interactive pieces
         (title, subreddit/author/open links) feed the same gesture engine:
         swipes that start on them still navigate, while clean taps keep
         their own behavior. Handlers live here once — events bubble up from
         whichever child was touched. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      id="meta-text"
      ontouchstart={viewerTouchStart}
      ontouchmove={viewerTouchMove}
      ontouchend={viewerTouchEnd}
      onpointerdown={viewerPointerDown}
      ondragstart={(e) => e.preventDefault()}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        id="meta-title"
        bind:this={titleEl}
        class:expanded
        class:truncatable
        onclick={() => {
          if (!recentDragEnd()) expanded = !expanded;
        }}
      >
        {post.title}
      </div>
      <div id="meta-sub">
        {#if post.subreddit}<a
            href="#{post.subreddit}"
            class="meta-feed-link"
            onclick={(e) => feedLink(e, post.subreddit)}>{post.subreddit}</a
          >
          ·
        {/if}
        {#if post.author}<a
            href="#u/{post.author}"
            class="meta-feed-link"
            onclick={(e) => feedLink(e, `user/${post.author}/submitted`)}>u/{post.author}</a
          >
          ·
        {/if}
        {#if post.nsfw}NSFW ·{/if}
        {#if post.kind === 'gallery'}{P.galleryIdx + 1}/{post.images.length} ·{/if}
        <a
          href={post.permalink}
          target="_blank"
          rel="noopener"
          onclick={(e) => {
            if (recentDragEnd()) e.preventDefault();
          }}>open ↗</a
        >
      </div>
    </div>
    <!-- Vertical action rail, reels-style: big icons with counts below. -->
    <div id="meta-actions">
      <button
        id="up-btn"
        class="icon-btn"
        class:active-up={post.likes === true}
        title="Upvote (a)"
        onclick={() => vote(1)}
      >
        <Icon name="arrow-big-up" filled={post.likes === true} />
        {#if post.score != null}<span class="action-count">{fmtCount(post.score)}</span>{/if}
      </button>
      <button
        id="down-btn"
        class="icon-btn"
        class:active-down={post.likes === false}
        title="Downvote (z)"
        onclick={() => vote(-1)}
      >
        <Icon name="arrow-big-down" filled={post.likes === false} />
      </button>
      <button
        id="save-btn"
        class="icon-btn"
        class:active-save={!!post.saved}
        title="Save (s)"
        onclick={toggleSave}
      >
        <Icon name="star" filled={!!post.saved} />
      </button>
      <button id="comments-btn" class="icon-btn" title="Comments (c)" onclick={openComments}>
        <Icon name="message-circle" />
        <span class="action-count">{fmtCount(post.numComments || 0)}</span>
      </button>
      <button id="share-btn" class="icon-btn" title="Share" onclick={sharePost}>
        <Icon name="share" />
      </button>
    </div>
  </footer>
{/if}
