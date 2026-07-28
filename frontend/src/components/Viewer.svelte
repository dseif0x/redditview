<script>
  import {
    P,
    next,
    prev,
    viewerTouchStart,
    viewerTouchMove,
    viewerTouchEnd,
    viewerPointerDown,
  } from '../lib/player.svelte.js';
  import { settings } from '../lib/settings.svelte.js';
  import Slide from './Slide.svelte';
</script>

<main
  id="viewer"
  class:fill={settings.fillScreen}
  ontouchstart={viewerTouchStart}
  ontouchmove={viewerTouchMove}
  ontouchend={viewerTouchEnd}
  onpointerdown={viewerPointerDown}
  ondragstart={(e) => e.preventDefault()}
>
  {#each P.window as entry (entry.uid)}
    <Slide {entry} />
  {/each}
  {#if P.rateBoost}
    <div id="rate-boost">2×</div>
  {/if}
  {#if P.message}
    {#if P.message.kind === 'intro'}
      <div id="empty-state">
        <h1>redditview</h1>
        <p>Enter any reddit feed above and press <strong>Go</strong>.</p>
        <p class="hint">
          Set your reddit cookie in the <strong>Settings</strong> tab for the home
          feed, private multireddits, and your own listings: type
          <strong>saved</strong>, <strong>upvoted</strong>,
          <strong>downvoted</strong>, or <strong>hidden</strong>.
        </p>
        <p class="hint">← / → navigate · space toggles autoscroll · m toggles sound</p>
      </div>
    {:else if P.message.kind === 'loading'}
      <div class="loading"><div class="spinner"></div></div>
    {:else}
      <div class="loading" class:error={P.message.error}>{P.message.text}</div>
    {/if}
  {/if}
</main>

<!-- Touch devices navigate by swiping; the click zones only steal edge taps
     (hidden on coarse pointers via CSS). -->
<button
  id="prev-zone"
  class="nav-zone"
  title={settings.vertical ? 'Previous (↑)' : 'Previous (←)'}
  onclick={prev}
>
  {settings.vertical ? '⌃' : '‹'}
</button>
<button
  id="next-zone"
  class="nav-zone"
  title={settings.vertical ? 'Next (↓)' : 'Next (→)'}
  onclick={next}
>
  {settings.vertical ? '⌄' : '›'}
</button>
