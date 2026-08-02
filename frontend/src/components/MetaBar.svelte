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
  import { mediaUrl } from '../lib/api.js';
  import { renderCommentHtml } from '../lib/commentHtml.js';
  import Icon from './Icon.svelte';

  const post = $derived(!P.message && P.idx >= 0 ? P.posts[P.idx] : null);

  let titleEl = $state(null);
  let expanded = $state(false);
  let truncatable = $state(false);

  // Media posts can carry body text; it shows as an Instagram-style caption
  // under the title — clamped with an ellipsis, tap to read it all — using
  // the same sanitized reddit HTML pipeline as comments. Text posts render
  // their body in the slide itself, so no caption there.
  let bodyBoxEl = $state(null);
  let bodyExpanded = $state(false);
  let bodyTruncatable = $state(false);
  const bodyRendered = $derived(
    post && post.kind !== 'text' && post.bodyHtml ? renderCommentHtml(post.bodyHtml, []) : ''
  );

  // Link posts show a preview image as the media — surface the actual
  // destination as a labeled link, like reddit's domain row.
  const linkHost = $derived.by(() => {
    if (!post?.linkUrl) return '';
    try {
      return new URL(post.linkUrl).hostname.replace(/^www\./, '');
    } catch {
      return post.linkUrl;
    }
  });
  $effect(() => {
    void bodyRendered;
    bodyExpanded = false;
    const el = bodyBoxEl;
    if (!el) return;
    requestAnimationFrame(() => {
      bodyTruncatable = el.scrollHeight > el.clientHeight + 1;
    });
  });

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

  // Native share sheet with the post's MEDIA when it's a plain file (the
  // shown image, the gallery's current image, an mp4): the recipient gets
  // the content, not a reddit link. HLS-only videos and text posts fall
  // back to sharing the permalink; no Web Share at all falls back to
  // copying the link.
  async function mediaShareFile() {
    const fileUrl =
      post.kind === 'video'
        ? post.videoMp4 || ''
        : (post.images || [])[post.kind === 'gallery' ? P.galleryIdx : 0] || '';
    if (!fileUrl || !navigator.canShare) return null;
    // Same proxied URL the slide rendered, so this is usually a cache hit —
    // important, because a slow fetch here would outlive the tap's transient
    // activation and iOS would refuse the share.
    const resp = await fetch(mediaUrl(fileUrl));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const type = blob.type || 'application/octet-stream';
    const ext =
      type.includes('mp4') ? 'mp4'
      : type.includes('png') ? 'png'
      : type.includes('gif') ? 'gif'
      : type.includes('webp') ? 'webp'
      : type.includes('svg') ? 'svg'
      : 'jpg';
    const name = (post.title || 'media').replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'media';
    const file = new File([blob], `${name}.${ext}`, { type });
    return navigator.canShare({ files: [file] }) ? file : null;
  }

  async function sharePost() {
    if (!post) return;
    try {
      if (navigator.share) {
        let file = null;
        try {
          file = await mediaShareFile();
        } catch {
          /* media not fetchable — share the link instead */
        }
        if (file) await navigator.share({ files: [file], title: post.title });
        else await navigator.share({ title: post.title, url: post.permalink });
      } else {
        await navigator.clipboard.writeText(post.permalink);
        showToast('Link copied', 1500);
      }
    } catch (err) {
      if (err?.name === 'AbortError') return; // dismissing the sheet is not an error
      // e.g. the file share lost the tap's activation window on a slow
      // fetch — leave the user with the link at least.
      try {
        await navigator.clipboard.writeText(post.permalink);
        showToast('Link copied', 1500);
      } catch {
        showToast('Could not share');
      }
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
      {#if post.linkUrl}
        <div id="meta-link">
          <a
            href={post.linkUrl}
            target="_blank"
            rel="noopener"
            onclick={(e) => {
              if (recentDragEnd()) e.preventDefault();
            }}>{linkHost} ↗</a
          >
        </div>
      {/if}
      {#if bodyRendered}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          id="meta-body"
          bind:this={bodyBoxEl}
          class:expanded={bodyExpanded}
          class:truncatable={bodyTruncatable}
          onclick={(e) => {
            const spoiler = e.target.closest?.('.md-spoiler-text');
            if (spoiler) {
              spoiler.classList.toggle('revealed');
              return;
            }
            if (e.target.closest?.('a, img')) return;
            if (!recentDragEnd()) bodyExpanded = !bodyExpanded;
          }}
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in renderCommentHtml -->
          {@html bodyRendered}
        </div>
      {/if}
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
