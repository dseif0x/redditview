<script>
  import { Tabs } from 'bits-ui';
  import { P, showTab } from '../lib/player.svelte.js';
  import { openFeedsMenu } from '../lib/feedsMenu.js';
  import Icon from './Icon.svelte';

  let el = $state(null);

  // The layout offsets (viewer, meta bar, progress dock, settings page) are
  // driven by the bar's REAL rendered height, so env()-math mismatches on
  // iOS can't open a gap. Track the rendered size continuously — the bar
  // grows when fonts/icons land.
  $effect(() => {
    if (!el) return;
    const node = el;
    const sync = () => {
      const h = node.offsetHeight;
      if (h) document.documentElement.style.setProperty('--tabbar-h', h + 'px');
    };
    sync();
    const onOrient = () => setTimeout(sync, 300);
    window.addEventListener('load', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', onOrient);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(sync);
      try {
        // border-box: the bar's height includes safe-area padding, which a
        // content-box observation would miss.
        ro.observe(node, { box: 'border-box' });
      } catch {
        ro.observe(node);
      }
    }
    return () => {
      window.removeEventListener('load', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', onOrient);
      ro?.disconnect();
    };
  });
</script>

<!-- Floating icon-only pill, reels-style: content runs full-bleed behind it
     and the active tab carries its own highlight. -->
<div id="tabbar" bind:this={el}>
  <Tabs.Root value={P.tab} onValueChange={showTab}>
    <Tabs.List class="tabbar-list">
      <Tabs.Trigger value="posts" class="tab" aria-label="Posts" title="Posts">
        <Icon name="images" />
      </Tabs.Trigger>
      <!-- Feeds is a launcher, not a page: a plain button (not a trigger) so
           every tap opens the menu and the active tab never moves off the
           current page. -->
      <button type="button" class="tab" aria-label="Feeds" title="Feeds" onclick={openFeedsMenu}>
        <Icon name="layers" />
      </button>
      <Tabs.Trigger value="settings" class="tab" aria-label="Settings" title="Settings">
        <Icon name="settings" />
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>
</div>
