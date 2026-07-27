<script>
  // Comments: bottom sheet (Bits UI Dialog) with the full comment tree,
  // sortable, tap a comment to collapse/expand its subtree.
  import { Dialog } from 'bits-ui';
  import { P, closeComments } from '../lib/player.svelte.js';
  import { api } from '../lib/api.js';
  import { presentActionSheet } from '../lib/sheet.svelte.js';
  import Comment from './Comment.svelte';
  import Icon from './Icon.svelte';

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

  async function load(post, sortVal) {
    view = { loading: true, comments: [], more: 0, error: '' };
    try {
      const data = await api(`/api/comments?id=${encodeURIComponent(post.id)}&sort=${sortVal}`);
      if (P.commentsPost !== post || !P.commentsOpen || sort !== sortVal) return; // user moved on
      view = { loading: false, comments: data.comments, more: data.more || 0, error: '' };
    } catch (err) {
      if (P.commentsPost !== post || !P.commentsOpen || sort !== sortVal) return;
      view = { loading: false, comments: [], more: 0, error: String(err.message || err) };
    }
  }

  $effect(() => {
    if (P.commentsOpen && P.commentsPost) load(P.commentsPost, sort);
  });

  async function pickSort() {
    const v = await presentActionSheet('Sort comments', SORTS, sort);
    if (v !== undefined) sort = v;
  }

  const sortText = $derived(SORTS.find((s) => s.value === sort)?.text || 'Best');
</script>

<Dialog.Root
  open={P.commentsOpen}
  onOpenChange={(o) => {
    if (!o) closeComments();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="comments-backdrop" />
    <Dialog.Content class="comments-sheet" aria-describedby={undefined}>
      <header id="comments-header">
        <Dialog.Title class="comments-title">
          {P.commentsPost?.numComments ? `Comments (${P.commentsPost.numComments})` : 'Comments'}
        </Dialog.Title>
        <button id="comments-sort" class="pill" type="button" title="Comment sort" onclick={pickSort}>
          {sortText}
        </button>
        <Dialog.Close class="icon-btn comments-close" title="Close (Esc)">
          <Icon name="x" />
        </Dialog.Close>
      </header>
      <div id="comments-list">
        {#if view.loading}
          <div class="loading"><div class="spinner"></div></div>
        {:else if view.error}
          <div class="loading error">Failed to load comments:{'\n'}{view.error}</div>
        {:else if view.comments.length === 0}
          <div class="loading">No comments yet.</div>
        {:else}
          {#each view.comments as c}
            <Comment {c} depth={0} />
          {/each}
          {#if view.more}
            <div class="c-more">… {view.more} more comments on reddit</div>
          {/if}
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
