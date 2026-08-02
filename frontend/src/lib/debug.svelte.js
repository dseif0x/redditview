// ---------------------------------------------------------------------------
// Audio + performance debug: every event that can affect sound is logged; the
// opt-in overlay (settings) shows the live element state plus the recent log,
// so audio failures can be diagnosed on-device without an inspector.
// ---------------------------------------------------------------------------
import { settings } from './settings.svelte.js';

export const dbg = $state({
  log: [],
  lastTransitionProfile: '',
});

export function alog(msg) {
  const t = new Date();
  dbg.log.push(`${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')} ${msg}`);
  if (dbg.log.length > 9) dbg.log.shift();
}

// Profiles one slide transition: frames rendered, worst frame gap, and how
// many frames exceeded two vsyncs (visible jank).
export function profileTransition(label, durationMs) {
  if (!settings.debug) return;
  const deltas = [];
  const t0 = performance.now();
  let last = t0;
  const tick = (ts) => {
    deltas.push(ts - last);
    last = ts;
    if (ts - t0 < durationMs + 120) requestAnimationFrame(tick);
    else {
      const worst = Math.max(...deltas);
      if (worst > 2000) return; // suspended mid-transition; not a real profile
      const janks = deltas.filter((d) => d > 32).length;
      dbg.lastTransitionProfile = `${label}: ${deltas.length}f, worst ${worst.toFixed(0)}ms, ${janks} jank`;
      if (janks) alog(`JANK ${dbg.lastTransitionProfile}`);
    }
  };
  requestAnimationFrame(tick);
}

// Times a known-heavy operation; anything blocking >8ms gets named in the log.
export function timed(name, fn) {
  if (!settings.debug) return fn();
  const t0 = performance.now();
  const r = fn();
  const dt = performance.now() - t0;
  if (dt > 8) alog(`SLOW ${name}: ${dt.toFixed(0)}ms`);
  return r;
}
