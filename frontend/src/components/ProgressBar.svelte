<script>
  import {
    P,
    registerProgress,
    repaintBar,
    progressPointerDown,
    progressPointerMove,
    progressPointerUp,
  } from '../lib/player.svelte.js';
  import { settings } from '../lib/settings.svelte.js';

  let rootEl = $state(null);
  let fillEl = $state(null);

  const pos = $derived(settings.moveBar ? settings.barPos : 'bottom');

  $effect(() => {
    if (rootEl && fillEl) registerProgress(rootEl, fillEl);
  });

  // Repaint the fill for the (possibly new) axis whenever the bar docks
  // somewhere else or flips its fill direction.
  $effect(() => {
    void pos;
    void settings.barInvert;
    if (fillEl) repaintBar();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  id="progress"
  bind:this={rootEl}
  class="pos-{pos}"
  class:invert={settings.barInvert}
  class:seekable={P.seekable}
  onpointerdown={progressPointerDown}
  onpointermove={progressPointerMove}
  onpointerup={progressPointerUp}
  onpointercancel={progressPointerUp}
>
  <div id="progress-track"><div id="progress-fill" bind:this={fillEl}></div></div>
</div>
