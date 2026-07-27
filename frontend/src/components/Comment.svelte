<script>
  // One comment with its subtree; tap to collapse/expand. Recursive.
  import Comment from './Comment.svelte';

  let { c, depth } = $props();
  let collapsed = $state(false);

  function countReplies(x) {
    let n = x.replies?.length || 0;
    for (const r of x.replies || []) n += countReplies(r);
    return n;
  }
  const kidCount = $derived(countReplies(c) + (c.moreCount || 0));

  function timeAgo(utcSeconds) {
    const s = Math.max(0, Date.now() / 1000 - utcSeconds);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 31536000) return Math.floor(s / 86400) + 'd';
    return Math.floor(s / 31536000) + 'y';
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="comment"
  class:nested={depth > 0}
  class:collapsed
  onclick={(e) => {
    e.stopPropagation(); // innermost comment wins, don't toggle ancestors
    collapsed = !collapsed;
  }}
>
  <div class="c-head">
    <span class="c-author" class:op={c.isSubmitter}>{c.author}</span>
    {#if c.isSubmitter}<span class="c-badge">OP</span>{/if}
    {#if c.distinguished === 'moderator'}<span class="c-badge">MOD</span>{/if}
    {#if c.stickied}<span class="c-badge">📌</span>{/if}
    <span class="c-meta">{c.scoreHidden ? '·' : c.score + ' pts'} · {timeAgo(c.createdUtc)}</span>
    <span class="c-collapsed-hint">[+{kidCount + 1}]</span>
  </div>
  <div class="c-body">{c.body}</div>
  <div class="c-kids">
    {#each c.replies || [] as r}
      <Comment c={r} depth={depth + 1} />
    {/each}
    {#if c.moreCount}
      <div class="c-more">… {c.moreCount} more repl{c.moreCount === 1 ? 'y' : 'ies'} on reddit</div>
    {/if}
  </div>
</div>
