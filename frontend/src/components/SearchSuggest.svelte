<script>
  import { untrack } from 'svelte';
  import { SOURCES, matchesQuery } from '../lib/searchSources.js';
  import { settings, saveSettings } from '../lib/settings.svelte.js';
  import { P, goToFeed } from '../lib/player.svelte.js';
  import Icon from './Icon.svelte';

  let { open = false, query = '', onpick } = $props();

  // Selected source and fetched results deliberately survive close/reopen:
  // dismissing the panel and coming back shows the exact same view.
  let sel = $state(null); // selected source id, or null = search everything
  let results = $state({}); // source id -> { status, items }

  // The input doubles as the current feed path, so text matching the loaded
  // feed is not a search — only other text counts as the query. (Derived
  // from the feed path rather than captured at open, so an abandoned search
  // is still a search when the panel reopens.)
  const q = $derived(query.trim() === (P.feedPath || '').trim() ? '' : query.trim().toLowerCase());

  const available = (s) => !s.needsCookie || !!settings.cookie.trim();

  // Pinned sources have no chip: their items ARE the panel's initial view.
  const chipSources = SOURCES.filter((s) => !s.pinned);
  const pinnedSources = $derived(SOURCES.filter((s) => s.pinned && available(s)));

  // Static sources refresh on every open, but in place: the previous list
  // stays rendered until the (cached-first, usually instant) reload lands,
  // so reopening never flashes. The body only depends on `open`: it writes
  // `results`, so everything else stays untracked to avoid re-triggering
  // itself.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      for (const s of SOURCES) {
        if (s.live || !available(s)) continue;
        if (results[s.id]?.status !== 'ready') results[s.id] = { status: 'loading', items: [] };
        s.items('').then(
          (items) => (results[s.id] = { status: 'ready', items }),
          () => {
            if (results[s.id]?.status === 'loading') results[s.id] = { status: 'error', items: [] };
          }
        );
      }
    });
  });

  // Live sources re-run with the query itself, debounced.
  $effect(() => {
    const current = q;
    if (!open) return;
    const timers = SOURCES.filter((s) => s.live && available(s)).map((s) =>
      setTimeout(() => {
        results[s.id] = { status: 'loading', items: results[s.id]?.items || [] };
        s.items(current).then(
          (items) => (results[s.id] = { status: 'ready', items }),
          () => (results[s.id] = { status: 'error', items: [] })
        );
      }, s.debounce ?? 250)
    );
    return () => timers.forEach(clearTimeout);
  });

  // Whatever items exist render — including a live source's previous
  // results while a re-query is in flight, so reopening shows the old
  // list instead of a spinner.
  function itemsFor(s) {
    const r = results[s.id];
    if (!r) return [];
    return s.live ? r.items : r.items.filter((it) => matchesQuery(it, q));
  }

  // Cross-source view: every available source that has matches (or is still
  // loading, so its section can show a spinner instead of flickering in).
  const sections = $derived(
    SOURCES.filter(available)
      .map((s) => ({ s, items: itemsFor(s) }))
      .filter((x) => x.items.length > 0 || results[x.s.id]?.status === 'loading')
  );

  function pick(it) {
    if (it.applySort !== undefined) {
      settings.sort = it.applySort;
      saveSettings();
    }
    onpick?.();
    goToFeed(it.path);
  }
</script>

{#snippet row(s, it)}
  <button type="button" class="sg-item" onclick={() => pick(it)}>
    <Icon name={it.icon || s.icon} />
    <span class="sg-label">{it.label}</span>
    {#if it.sublabel}<span class="sg-sub">{it.sublabel}</span>{/if}
  </button>
{/snippet}

<!-- pointerdown is swallowed so taps inside the panel never blur the input
     (blur is what closes the panel) -->
{#if open}
  <div id="suggest" onpointerdown={(e) => e.preventDefault()}>
    <div class="sg-chips">
      {#each chipSources as s (s.id)}
        <button
          type="button"
          class="sg-chip"
          class:active={sel === s.id}
          onclick={() => (sel = sel === s.id ? null : s.id)}
        >
          <Icon name={s.icon} />
          {s.label}
        </button>
      {/each}
    </div>
    <div class="sg-body">
      {#if sel}
        {@const s = SOURCES.find((x) => x.id === sel)}
        {#if !available(s)}
          <p class="sg-note">Set your reddit cookie in the Settings tab to browse this.</p>
        {:else if itemsFor(s).length > 0}
          {#each itemsFor(s) as it (it.path + (it.sublabel || ''))}
            {@render row(s, it)}
          {/each}
        {:else if results[s.id]?.status === 'loading'}
          <div class="sg-loading"><span class="spinner"></span></div>
        {:else if results[s.id]?.status === 'error'}
          <p class="sg-note">Couldn't load this right now — try again in a moment.</p>
        {:else}
          <p class="sg-note">{q.length >= (s.minQuery || 1) ? 'No matches here.' : s.empty}</p>
        {/if}
      {:else if !q}
        {#if pinnedSources.length === 0}
          <p class="sg-note">
            Search your followed users, subscribed subreddits and saved feeds — or pick a source
            above.
          </p>
        {:else}
          {#each pinnedSources as s (s.id)}
            {#each itemsFor(s) as it (it.path)}
              {@render row(s, it)}
            {/each}
          {/each}
        {/if}
      {:else if sections.length === 0}
        <p class="sg-note">No matches — press Go to open “{query.trim()}” directly.</p>
      {:else}
        {#each sections as sec (sec.s.id)}
          <div class="sg-head"><Icon name={sec.s.icon} />{sec.s.label}</div>
          {#if sec.items.length > 0}
            {#each sec.items as it (it.path + (it.sublabel || ''))}
              {@render row(sec.s, it)}
            {/each}
          {:else}
            <div class="sg-loading"><span class="spinner"></span></div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/if}
