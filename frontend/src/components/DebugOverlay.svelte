<script>
  // Opt-in overlay (settings): live video element state, fps, and the recent
  // audio/perf log, so failures can be diagnosed on-device without an
  // inspector.
  import { P } from '../lib/player.svelte.js';
  import { settings } from '../lib/settings.svelte.js';
  import { dbg } from '../lib/debug.svelte.js';

  let text = $state('');

  const frameDeltas = [];
  let perfLast = 0;
  let perfRafId = null;

  function perfLoop(ts) {
    if (!settings.debug) {
      perfRafId = null;
      perfLast = 0;
      frameDeltas.length = 0;
      return;
    }
    if (perfLast) {
      const d = ts - perfLast;
      // Gaps of seconds are app suspension (screen lock, app switch), not jank.
      if (d < 2000) {
        frameDeltas.push(d);
        if (frameDeltas.length > 120) frameDeltas.shift();
      }
    }
    perfLast = ts;
    perfRafId = requestAnimationFrame(perfLoop);
  }

  $effect(() => {
    const iv = setInterval(() => {
      if (!settings.debug) {
        text = '';
        return;
      }
      if (perfRafId == null) perfRafId = requestAnimationFrame(perfLoop);
      const v = P.currentVideo;
      const audio = v
        ? `el: muted=${v.muted} paused=${v.paused} ready=${v.readyState} rate=${v.playbackRate}`
        : 'el: (no video)';
      let fps = '';
      if (frameDeltas.length > 10) {
        const avg = frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length;
        const worst = Math.max(...frameDeltas);
        fps = `fps ~${(1000 / avg).toFixed(0)}, worst frame ${worst.toFixed(0)}ms`;
      }
      text = [
        `${P.muted ? 'MUTED' : 'audio on'} | ${audio}`,
        [fps, dbg.lastTransitionProfile].filter(Boolean).join(' | '),
        ...dbg.log,
      ]
        .filter(Boolean)
        .join('\n');
    }, 500);
    return () => {
      clearInterval(iv);
      if (perfRafId != null) cancelAnimationFrame(perfRafId);
      perfRafId = null;
    };
  });
</script>

{#if settings.debug && text}
  <div id="debug-overlay">{text}</div>
{/if}
