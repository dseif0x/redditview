<script>
  // Opt-in overlay (settings): live video element state, fps, and the recent
  // audio/perf log, so failures can be diagnosed on-device without an
  // inspector.
  import { P } from '../lib/player.svelte.js';
  import { settings, activeCookie, cookieSig } from '../lib/settings.svelte.js';
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

  // Reads the real env(safe-area-inset-bottom) via a probe element, so the
  // overlay can show what the device actually reports.
  let envProbe = null;
  function envBottom() {
    if (!envProbe) {
      envProbe = document.createElement('div');
      envProbe.style.cssText =
        'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)';
      document.body.appendChild(envProbe);
    }
    return getComputedStyle(envProbe).paddingBottom;
  }

  // Viewport geometry: everything needed to diagnose bottom-inset issues
  // (standalone letterboxing, leftover scroll, env double-counting) from a
  // single on-device screenshot.
  function viewportLine() {
    const landscape = window.innerWidth > window.innerHeight;
    const screenH = landscape
      ? Math.min(screen.width, screen.height)
      : Math.max(screen.width, screen.height);
    const vv = window.visualViewport;
    const app = document.getElementById('app');
    const bar = document.getElementById('tabbar');
    const standalone =
      navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches;
    return [
      `vp: ${standalone ? 'standalone' : 'browser'} scr=${screenH} inner=${window.innerHeight}`,
      `icb=${document.documentElement.clientHeight}`,
      `vv=${vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop + vv.pageTop)}` : '-'}`,
      `y=${Math.round(window.scrollY)} envB=${envBottom()}`,
      `appB=${app ? Math.round(app.getBoundingClientRect().bottom) : '-'}`,
      `barB=${bar ? Math.round(bar.getBoundingClientRect().bottom) : '-'}`,
      `lb=${document.documentElement.style.getPropertyValue('--bottom-letterbox') || '0px'}`,
    ].join(' ');
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
      // Provenance of the active post: which upstream host served its page,
      // which cursor fetched it, and whether the fetching account matches
      // the currently active one — for diagnosing stray posts in the feed.
      let postLine = '';
      const post = P.posts[P.idx];
      if (post) {
        const sig = cookieSig(activeCookie());
        const acct = post._sig ? (post._sig === sig ? 'ok' : `MIXED ${post._sig}≠${sig}`) : '?';
        postLine = `post: ${post.subreddit || post.name} host=${post._host || '?'} u=${post._user || '?'} cur=${post._cursor || '(first)'} acct=${acct}`;
      }
      text = [
        `${P.muted ? 'MUTED' : 'audio on'} | ${audio}`,
        postLine,
        viewportLine(),
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
      envProbe?.remove();
      envProbe = null;
    };
  });
</script>

{#if settings.debug && text}
  <div id="debug-overlay">{text}</div>
{/if}
