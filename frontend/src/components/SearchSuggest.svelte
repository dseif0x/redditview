<script>
  import { untrack } from 'svelte';
  import { SOURCES, matchesQuery } from '../lib/searchSources.js';
  import { settings, saveSettings } from '../lib/settings.svelte.js';
  import { goToFeed } from '../lib/player.svelte.js';
  import Icon from './Icon.svelte';

  let { open = false, query = '', onpick } = $props();

  let sel = $state(null); // selected source id, or null = search everything
  let results = $state({}); // source id -> { status, items }

  // The input doubles as the current feed path, so whatever it held when
  // the panel opened is not a search — only text the user types after
  // focusing counts as the query.
  let baseline = $state('');
  const q = $derived(query === baseline ? '' : query.trim().toLowerCase());

  const available = (s) => !s.needsCookie || !!settings.cookie.trim();

  // Static sources fetch their full list once per panel open and are
  // filtered client-side while typing. The body only depends on `open`:
  // it writes `results`, so everything else stays untracked to avoid
  // re-triggering itself.
  $effect(() => {
    if (!open) {
      untrack(() => (sel = null));
      return;
    }
    untrack(() => {
      baseline = query;
      results = {};
      for (const s of SOURCES) {
        if (s.live || !available(s)) continue;
        results[s.id] = { status: 'loading', items: [] };
        s.items('').then(
          (items) => (results[s.id] = { status: 'ready', items }),
          () => (results[s.id] = { status: 'error', items: [] })
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

  function itemsFor(s) {
    const r = results[s.id];
    if (!r || r.status !== 'ready') return [];
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
    <Icon name={s.icon} />
    <span class="sg-label">{it.label}</span>
    {#if it.sublabel}<span class="sg-sub">{it.sublabel}</span>{/if}
  </button>
{/snippet}

<!-- pointerdown is swallowed so taps inside the panel never blur the input
     (blur is what closes the panel) -->
{#if open}
  <div id="suggest" onpointerdown={(e) => e.preventDefault()}>
    <div class="sg-chips">
      {#each SOURCES as s (s.id)}
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
        {:else if results[s.id]?.status === 'loading'}
          <div class="sg-loading"><span class="spinner"></span></div>
        {:else if results[s.id]?.status === 'error'}
          <p class="sg-note">Couldn't load this right now — try again in a moment.</p>
        {:else if itemsFor(s).length === 0}
          <p class="sg-note">{q ? 'No matches here.' : s.empty}</p>
        {:else}
          {#each itemsFor(s) as it (it.path + (it.sublabel || ''))}
            {@render row(s, it)}
          {/each}
        {/if}
      {:else if !q}
        <p class="sg-note">
          Search your followed users, subscribed subreddits and saved feeds — or pick a source
          above.
        </p>
      {:else if sections.length === 0}
        <p class="sg-note">No matches — press Go to open “{query.trim()}” directly.</p>
      {:else}
        {#each sections as sec (sec.s.id)}
          <div class="sg-head"><Icon name={sec.s.icon} />{sec.s.label}</div>
          {#if results[sec.s.id]?.status === 'loading'}
            <div class="sg-loading"><span class="spinner"></span></div>
          {:else}
            {#each sec.items as it (it.path + (it.sublabel || ''))}
              {@render row(sec.s, it)}
            {/each}
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/if}
