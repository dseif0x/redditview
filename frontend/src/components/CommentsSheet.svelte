<script>
  // Comments: bottom sheet (Bits UI Dialog) with the full comment tree,
  // sortable, tap a comment to collapse/expand its subtree.
  import { Dialog } from 'bits-ui';
  import { P, closeComments } from '../lib/player.svelte.js';
  import { api } from '../lib/api.js';
  import Comment from './Comment.svelte';
  import Icon from './Icon.svelte';
  import PickerSelect from './PickerSelect.svelte';

  const SORTS = [
    { text: 'Best', value: 'confidence' },
    { text: 'Top', value: 'top' },
    { text: 'New', value: 'new' },
    { text: 'Controversial', value: 'controversial' },
    { text: 'Old', value: 'old' },
    { text: 'Q&A', value: 'qa' },
  ];
  let sort = $state('confidence');
  let view = $state({ loading: true, comments: [], more: 0, error: '' });

  // With a focus comment (a comment permalink was followed) the sheet shows
  // that comment's thread — its ancestors for context and its replies —
  // instead of the whole page, until "all comments" is tapped.
  async function load(post, sortVal, focus) {
    view = { loading: true, comments: [], more: 0, error: '' };
    const stale = () => P.commentsPost !== post || !P.commentsOpen || sort !== sortVal || P.commentsFocus !== focus;
    try {
      let url = `/api/comments?id=${encodeURIComponent(post.id)}&sort=${sortVal}`;
      if (focus) url += `&comment=${encodeURIComponent(focus)}`;
      const data = await api(url);
      if (stale()) return; // user moved on
      view = { loading: false, comments: data.comments, more: data.more || 0, error: '' };
    } catch (err) {
      if (stale()) return;
      view = { loading: false, comments: [], more: 0, error: String(err.message || err) };
    }
  }

  $effect(() => {
    if (P.commentsOpen && P.commentsPost) load(P.commentsPost, sort, P.commentsFocus);
  });

</script>

<Dialog.Root
  open={P.commentsOpen}
  onOpenChange={(o) => {
    if (!o) closeComments();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="comments-backdrop" />
    <!-- No auto-focus on open: the sheet reaches the real screen bottom,
         below iOS's cut-short standalone layout viewport — focusing it
         makes WebKit scroll the whole app up and snap back. -->
    <Dialog.Content
      class="comments-sheet"
      aria-describedby={undefined}
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <header id="comments-header">
        <Dialog.Title class="comments-title">
          {P.commentsPost?.numComments ? `Comments (${P.commentsPost.numComments})` : 'Comments'}
        </Dialog.Title>
        <PickerSelect
          id="comments-sort"
          items={SORTS}
          value={sort}
          onchange={(v) => {
            if (v) sort = v;
          }}
        />
        <Dialog.Close class="icon-btn comments-close" title="Close (Esc)">
          <Icon name="x" />
        </Dialog.Close>
      </header>
      <div id="comments-list">
        {#if P.commentsFocus}
          <div class="c-focus">
            Showing one thread ·
            <button type="button" class="c-focus-all" onclick={() => (P.commentsFocus = '')}>
              All comments
            </button>
          </div>
        {/if}
        {#if view.loading}
          <div class="loading"><div class="spinner"></div></div>
        {:else if view.error}
          <div class="loading error">Failed to load comments:{'\n'}{view.error}</div>
        {:else if view.comments.length === 0}
          <div class="loading">No comments yet.</div>
        {:else}
          {#each view.comments as c}
            <Comment {c} depth={0} focus={P.commentsFocus} />
          {/each}
          {#if view.more}
            <div class="c-more">… {view.more} more comments on reddit</div>
          {/if}
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
