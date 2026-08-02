// ---------------------------------------------------------------------------
// The player engine: feed loading, the slide window, autoscroll timers, the
// progress bar, gestures, history, votes and audio handling. Components read
// the reactive `P` state and register controllers for their mounted slides;
// the engine drives them imperatively where timing matters (activation,
// deferred mounts, the video pool), exactly like the pre-Svelte app did.
// ---------------------------------------------------------------------------
import { flushSync } from 'svelte';
import Hls from 'hls.js';
import { settings, saveSettings, markSeen, hasSeen } from './settings.svelte.js';
import { api, mediaUrl } from './api.js';
import { showToast } from './toast.svelte.js';
import { alog, timed, profileTransition } from './debug.svelte.js';

export const SLIDE_MS = 350;

export const P = $state({
  feedInput: settings.lastFeed,
  feedPath: '',
  feedActive: false,
  posts: [],
  idx: -1,
  galleryIdx: 0,
  // Every session starts muted: the first unmute tap is the user interaction
  // that grants (and pool-blesses) audio playback rights.
  muted: true,
  // Slide window entries: {uid, pos, off, animate, evicted, preloadHint}.
  window: [],
  activeUid: null,
  dragging: false,
  dragPx: 0,
  galleryDragging: false,
  galleryDragPx: 0,
  // Full-screen viewer message: {kind:'intro'} | {kind:'loading'} |
  // {text, error} | null (slides showing).
  message: { kind: 'intro' },
  seekable: false,
  currentVideo: null,
  rateBoost: false, // holding down on a playing video runs it at 2x
  commentsOpen: false,
  commentsPost: null,
  tab: 'posts',
});

// ---------------------------------------------------------------------------
// Feed state (non-reactive internals)
// ---------------------------------------------------------------------------
// Reddit's cursor pagination shifts on active feeds, so later pages can
// re-serve posts already loaded; track what's in the feed and drop repeats.
let loadedNames = new Set();
let after = null;
let exhausted = false;
let loadingPage = false;

// The post a resume is targeting must never be filtered as already-seen.
let resumeExemptName = null;

// ---------------------------------------------------------------------------
// Slide controllers: each mounted Slide component registers an imperative
// interface (video element access, gallery stepping, media for pinch-zoom).
// ---------------------------------------------------------------------------
const controllers = new Map(); // uid -> controller
const byPos = new Map(); // pos -> window entry (non-evicted only)
let uidSeq = 0;

export function registerController(uid, ctrl) {
  controllers.set(uid, ctrl);
  return () => {
    if (controllers.get(uid) === ctrl) controllers.delete(uid);
  };
}

export function isEntryActive(uid) {
  return P.activeUid === uid;
}

function activeController() {
  return P.activeUid != null ? controllers.get(P.activeUid) : null;
}

// ---------------------------------------------------------------------------
// Sort. Rewrites the feed path for the selected sort mode: listing feeds
// (home/subreddit/multi) take the sort as a trailing path segment, user pages
// take ?sort=/&t= query params, and the per-user pseudo-feeds ignore it.
// ---------------------------------------------------------------------------
const SORT_SEGMENTS = ['hot', 'new', 'rising', 'top', 'controversial', 'best'];

function applySort(raw) {
  if (!settings.sort) return raw;
  const [sort, t] = settings.sort.split(':');

  // Strip scheme/host from pasted URLs so path logic below works.
  if (raw.includes('://')) {
    raw = raw.slice(raw.indexOf('://') + 3);
    const slash = raw.indexOf('/');
    raw = slash >= 0 ? raw.slice(slash + 1) : '';
  }
  const qi = raw.indexOf('?');
  let path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/^\/+|\/+$/g, '');
  const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');

  if (['saved', 'upvoted', 'downvoted', 'hidden'].includes(path)) return raw;

  t ? params.set('t', t) : params.delete('t');

  // User listing pages (not multireddits) sort via query params.
  if (/^(u|user)\/[^/]+(\/(submitted|posts|overview|comments|gilded))?$/i.test(path)) {
    params.set('sort', sort);
    return path + '?' + params.toString();
  }

  const parts = path.split('/').filter(Boolean);
  if (SORT_SEGMENTS.includes(parts[parts.length - 1])) parts.pop();
  parts.push(sort);
  const q = params.toString();
  return parts.join('/') + (q ? '?' + q : '');
}

function kindEnabled(post) {
  switch (post.kind) {
    case 'video':
      return settings.showVideos;
    case 'text':
      return settings.showText;
    default: // image + gallery
      return settings.showImages;
  }
}

async function fetchPage() {
  if (loadingPage || exhausted) return;
  loadingPage = true;
  try {
    // A page may contain only filtered-out kinds; keep paging (bounded) until
    // something usable shows up.
    for (let attempts = 0; attempts < 5; attempts++) {
      const params = new URLSearchParams({ path: applySort(P.feedPath) });
      if (after) params.set('after', after);
      const data = await api('/api/feed?' + params.toString());
      const cursorUsed = after || '';
      const added = data.posts.filter(
        (p) =>
          kindEnabled(p) &&
          !loadedNames.has(p.name || p.id) &&
          (!settings.skipSeen || !hasSeen(p.id) || p.name === resumeExemptName)
      );
      // Remember which cursor fetched each post so the feed can resume here.
      for (const p of added) {
        p._cursor = cursorUsed;
        loadedNames.add(p.name || p.id);
      }
      P.posts.push(...added);
      after = data.after || null;
      if (!after) {
        exhausted = true;
        break;
      }
      if (added.length > 0) break;
    }
  } finally {
    loadingPage = false;
  }
}

export async function startFeed(path, resume = null) {
  stopSlide();
  P.posts = [];
  loadedNames = new Set();
  after = resume?.cursor || null;
  exhausted = false;
  P.idx = -1;
  P.feedPath = path;
  P.feedActive = true;
  settings.lastFeed = path;
  saveSettings();

  P.message = { kind: 'loading' };
  resumeExemptName = resume?.name || null;

  try {
    await fetchPage();
  } catch (err) {
    P.message = { text: `Failed to load feed:\n${String(err.message || err)}`, error: true };
    return;
  }
  if (P.posts.length === 0) {
    P.message = { text: 'No viewable posts in this feed.' };
    return;
  }
  // When resuming, jump straight to the remembered post if it's still there.
  const at = resume ? P.posts.findIndex((p) => p.name === resume.name) : -1;
  if (at >= 0) showSlide(at, 0);
  else next();
}

// ---------------------------------------------------------------------------
// Feed history: every user-initiated feed change is a browser history entry
// whose state carries the position in the feed being left, so back/forward
// (browser buttons, browser gestures, and the in-app edge swipes) restore
// both the feed and where you were in it.
// ---------------------------------------------------------------------------
function currentHistoryState() {
  const p = P.posts[P.idx];
  return { feed: P.feedPath, sort: settings.sort, cursor: p?._cursor || '', name: p?.name || null };
}

let histTimer = null;
let bookkeepTimer = null;
function stampHistoryEntry() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    try {
      history.replaceState(currentHistoryState(), '');
    } catch {
      /* Safari throttles replaceState; the next slide will retry */
    }
  }, 400);
}

// User-initiated feed change: snapshot the feed being left, push a new entry.
export function goToFeed(path) {
  try {
    if (P.feedActive) {
      clearTimeout(histTimer);
      history.replaceState(currentHistoryState(), '');
      history.pushState({ feed: path, sort: settings.sort }, '');
    } else {
      history.replaceState({ feed: path, sort: settings.sort }, '');
    }
  } catch {
    /* history unavailable/throttled — navigation still works, just untracked */
  }
  P.feedInput = path;
  startFeed(path);
}

let lastPopstateAt = 0;

function maybePrefetch() {
  if (P.idx >= P.posts.length - 5 && !exhausted && !loadingPage) {
    fetchPage().catch((err) => showToast('Failed to load more: ' + err.message));
  }
}

// ---------------------------------------------------------------------------
// Progress bar. The bar normally lives at the bottom; with the movable-bar
// option a tap near a screen edge docks it there. Left/right docks are
// vertical, so the fill axis and seek axis depend on the current position.
// ---------------------------------------------------------------------------
let progressEl = null;
let progressFill = null;

export function registerProgress(rootEl, fillEl) {
  progressEl = rootEl;
  progressFill = fillEl;
}

export const effectiveBarPos = () =>
  settings.barMode === 'auto' ? settings.barPos : settings.barMode;
export const barIsVertical = () => effectiveBarPos() === 'left' || effectiveBarPos() === 'right';
const fillProp = () => (barIsVertical() ? 'height' : 'width');

function paintFill(value, transitionMs = 0) {
  if (!progressFill) return;
  progressFill.style.transition = transitionMs ? `${fillProp()} ${transitionMs}ms linear` : 'none';
  progressFill.style[fillProp()] = value;
}

// Repaint the fill for the (possibly new) axis after the bar moves.
export function repaintBar() {
  if (!progressFill) return;
  progressFill.style.transition = 'none';
  progressFill.style.width = '';
  progressFill.style.height = '';
  if (P.currentVideo?.duration) {
    paintFill((P.currentVideo.currentTime / P.currentVideo.duration) * 100 + '%');
  } else if (timerId != null) {
    startTimer(settings.imageSeconds); // restart the countdown on the new axis
  }
}

// ---------------------------------------------------------------------------
// Autoscroll timer (images / galleries / text) with progress bar. Only runs
// when autoscroll is enabled; otherwise slides stay until manually advanced.
// ---------------------------------------------------------------------------
let timerId = null;
let timerStartedAt = 0;
let timerRemainingMs = 0;

function startTimer(seconds) {
  clearTimer();
  if (!settings.autoscroll) return;
  timerRemainingMs = seconds * 1000;
  paintFill('0%');
  // Force reflow so the reset applies before the transition starts.
  if (progressFill) void progressFill.offsetWidth;
  resumeTimer();
}

// Tapping an image/text slide pauses the countdown, like pausing a video.
function pauseTimer() {
  if (timerId == null) return;
  clearTimeout(timerId);
  timerId = null;
  timerRemainingMs = Math.max(0, timerRemainingMs - (Date.now() - timerStartedAt));
  if (progressFill) paintFill(getComputedStyle(progressFill)[fillProp()]);
}

function resumeTimer() {
  if (timerId != null || timerRemainingMs <= 0 || !settings.autoscroll) return;
  timerStartedAt = Date.now();
  timerId = setTimeout(onTimerDone, timerRemainingMs);
  paintFill('100%', timerRemainingMs);
}

function clearTimer() {
  clearTimeout(timerId);
  timerId = null;
  timerRemainingMs = 0;
  paintFill('0%');
}

function onTimerDone() {
  timerId = null;
  // Galleries show every image for the configured duration before moving on.
  if (galleryStep(1)) return;
  next();
}

// Tapping a non-video slide pauses/resumes the autoscroll countdown, the
// same way tapping a video pauses playback.
export function timerTapToggle() {
  if (!settings.autoscroll) return;
  if (timerId != null) pauseTimer();
  else resumeTimer();
}

// ---------------------------------------------------------------------------
// Video element pool. WebKit grants playback-with-sound rights PER ELEMENT,
// permanently, once the element has played inside a user gesture. A fresh
// element per slide starts with no rights, so every gestureless playback
// start (autoscroll advance, source fallback, redgifs resolution) was force-
// muted. Recycling a small pool means the first few swipes bless the
// elements and everything after — gestureless or not — plays with sound.
// ---------------------------------------------------------------------------
const videoPool = [];
const POOL_TARGET = 4;

export function takeVideo() {
  return videoPool.pop() || document.createElement('video');
}

export function releasePooledVideo(v) {
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  try {
    v.load(); // fully detach the old source
  } catch {
    /* ignore */
  }
  v.muted = true;
  v.loop = false;
  v.playbackRate = 1;
  v.removeAttribute('poster');
  v.remove();
  v.__pooled = true;
  if (videoPool.length < 6) videoPool.push(v);
}

// The canonical iOS unlock: on the first user gesture, top the pool up and
// have every element play a tiny silent clip inside the gesture. That
// permanently blesses them, so later (deferred/gestureless) playback starts
// keep their sound. Zero-amplitude samples — nothing audible.
const SILENT_CLIP =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
let poolUnlocked = false;
let unlockAttempts = 0;
let lastUnlockTry = 0;

function unlockVideoPool() {
  // Bounded and throttled: a device where the silent clip fails must not
  // re-run the whole unlock (4 plays + resets) on every gesture — that
  // showed up as transition jank. Organic blessing via swipes covers it.
  if (poolUnlocked || unlockAttempts >= 4 || Date.now() - lastUnlockTry < 3000) return;
  unlockAttempts++;
  lastUnlockTry = Date.now();
  poolUnlocked = true;
  while (videoPool.length < POOL_TARGET) videoPool.push(document.createElement('video'));
  let n = 0;
  for (const v of videoPool) {
    if (v.__blessed) continue;
    n++;
    v.playsInline = true;
    v.muted = false;
    v.src = SILENT_CLIP;
    const pr = v.play();
    pr?.then(() => {
      v.__blessed = true;
      v.__pooled = true; // unlock-seeded elements ARE pool elements
      // The reset (load) is main-thread work; keep it clear of any swipe
      // transition the unlocking gesture may have started.
      setTimeout(() => {
        v.pause();
        v.removeAttribute('src');
        try {
          v.load();
        } catch {
          /* ignore */
        }
      }, 1000);
    }).catch((err) => {
      alog(`unlock failed: ${err?.name}`);
      poolUnlocked = false; // didn't take; bounded retry on a later gesture
    });
  }
  if (n) alog(`pool unlock: blessing ${n} elements`);
}

// Autoplay with sound is often blocked before user interaction: fall back
// to muted playback rather than stalling the feed (unmute with 🔇 / m).
// ONLY an actual policy rejection may trigger the muted fallback — play()
// also rejects with AbortError when a pause/new-source interrupts a pending
// start, and muting on those silenced videos for no reason.
export function attemptPlay(video) {
  video.play().catch((err) => {
    console.warn('play() rejected:', err?.name, err?.message);
    alog(`play rejected: ${err?.name}${P.currentVideo === video ? '' : ' (stale)'}`);
    if (err?.name !== 'NotAllowedError') return;
    if (P.currentVideo !== video) return; // slide changed while play was pending
    if (!video.muted) {
      video.muted = true; // policy fallback; the next gesture restores audio
      alog('policy fallback: muted element');
      video.play().catch(() => {});
    }
  });
}

// Reddit's transcode of redgifs posts has no audio; ask the backend to
// resolve the real (signed, expiring) redgifs mp4 first.
export async function resolveRedgifs(post) {
  try {
    const data = await api('/api/redgifs?id=' + encodeURIComponent(post.redgifsId));
    if (data.mp4) {
      post.redgifsMp4 = data.mp4;
      if (!post.poster && data.poster) post.poster = data.poster;
      return;
    }
  } catch {
    /* fall through to reddit's silent transcode */
  }
  console.warn('redgifs lookup failed for', post.redgifsId, '— using silent reddit preview');
}

export { Hls, mediaUrl };

// ---------------------------------------------------------------------------
// Slide window: the previous, current, and next posts stay mounted so
// neighbors are preloaded before you reach them and visible while swiping.
// Entries are keyed by uid (not position) so an evicted slide can linger
// off-screen through the transition while its position is remounted.
// ---------------------------------------------------------------------------
const keyOf = (pos) => 'p' + pos;
const nextPosOf = (pos) => (P.posts[pos + 1] ? pos + 1 : null);
const prevPosOf = (pos) => (pos > 0 ? pos - 1 : null);

function addEntry(pos, off, preloadHint = null) {
  P.window.push({ uid: ++uidSeq, pos, off, animate: false, evicted: false, preloadHint });
  const entry = P.window[P.window.length - 1]; // the reactive proxy
  byPos.set(pos, entry);
  return entry;
}

function removeEntry(uid) {
  const i = P.window.findIndex((e) => e.uid === uid);
  if (i < 0) return;
  const entry = P.window[i];
  if (byPos.get(entry.pos)?.uid === uid) byPos.delete(entry.pos);
  P.window.splice(i, 1); // component teardown releases media/hls
}

function stopSlide() {
  clearTimer();
  P.seekable = false;
  P.currentVideo = null;
  P.activeUid = null;
  byPos.clear();
  P.window.length = 0;
}

function activateEntry(entry, animating = false) {
  const post = P.posts[entry.pos];
  P.idx = entry.pos;
  const ctrl = controllers.get(entry.uid);
  P.galleryIdx = ctrl?.galleryIdx ? ctrl.galleryIdx() : 0;
  // Bookkeeping does synchronous localStorage/history writes (the settings
  // JSON carries multi-KB cookies) — keep it off the transition frames.
  clearTimeout(bookkeepTimer);
  bookkeepTimer = setTimeout(
    () => {
      settings.resume = { path: P.feedPath, sort: settings.sort, cursor: post._cursor || '', name: post.name };
      saveSettings();
      markSeen(post.id);
      stampHistoryEntry();
    },
    animating ? SLIDE_MS + 200 : 50
  );
  const video = ctrl?.getVideo ? ctrl.getVideo() : null;
  const fresh = P.currentVideo !== video || !video;
  if (ctrl?.isFailed?.()) {
    showToast('Media failed to load, skipping');
    setTimeout(() => P.activeUid === entry.uid && next(), 700);
  }
  if (video) {
    clearTimer();
    P.currentVideo = video;
    video.muted = P.muted;
    video.loop = !settings.autoscroll;
    video.playbackRate = 1; // pooled elements may carry a hold-boost rate
    alog(`activate ${keyOf(entry.pos)}: muted=${P.muted} animating=${animating}`);
    P.seekable = true;
    paintFill('0%');
    // Starting playback spins up the decoder and audio pipeline, which makes
    // the slide transition stutter — let the (already decoded) first frame
    // glide in and start playing once the animation settles.
    const startPlayback = () => {
      if (P.activeUid !== entry.uid) return;
      if (fresh && video.currentTime > 0) video.currentTime = 0;
      attemptPlay(video);
    };
    // Playback is deferred past the transition so decoder spin-up can't make
    // it stutter. The blessed element pool is what keeps audio rights alive
    // across this deferral (and across gestureless starts) on iOS.
    if (animating) setTimeout(startPlayback, SLIDE_MS);
    else startPlayback();
  } else {
    P.currentVideo = null;
    P.seekable = false;
    startTimer(settings.imageSeconds);
  }
}

// A slide whose media arrived late (redgifs resolution) re-activates itself.
export function activateIfCurrent(uid) {
  if (P.activeUid !== uid) return;
  const entry = P.window.find((e) => e.uid === uid);
  if (entry) activateEntry(entry, false);
}

// Media failure reported by a slide that is currently active: skip ahead.
export function skipFailedSlide(uid, delayMs = 800) {
  setTimeout(() => {
    if (P.activeUid === uid) next();
  }, delayMs);
}

// Mount the window around pos and make pos the active slide.
// dir: 1 = advancing, -1 = going back, 0 = reposition without animation.
export function showSlide(pos, dir = 0) {
  if (!P.posts[pos]) return;
  if (P.commentsOpen && P.commentsPost !== P.posts[pos]) closeComments();
  P.message = null;

  const oldCtrl = activeController();
  const oldEntry = P.activeUid != null ? P.window.find((e) => e.uid === P.activeUid) : null;
  if (oldEntry && oldEntry.pos !== pos) oldCtrl?.deactivate?.();
  const hadSlides = P.window.some((e) => !e.evicted);

  const want = [{ pos, off: 0 }];
  const pp = prevPosOf(pos);
  if (pp != null) want.push({ pos: pp, off: -100 });
  // Posts ahead stay mounted per the preload setting, parked at their slide
  // offsets — mounting is what makes their media load, so skipping forward
  // lands on content instead of a black frame.
  const ahead = Math.max(1, Math.min(4, Math.round(settings.preloadCount) || 1));
  for (let k = 1; k <= ahead && P.posts[pos + k]; k++) {
    want.push({ pos: pos + k, off: 100 * k });
  }
  const wantPos = new Set(want.map((w) => w.pos));

  const animate = settings.smoothScroll && dir !== 0;
  for (const entry of [...P.window]) {
    if (entry.evicted || wantPos.has(entry.pos)) continue;
    if (animate) {
      // Teardown (hls destroy, media element reset) is heavy; do it after
      // the transition. The evicted slide is off-screen and silent already.
      entry.evicted = true;
      if (byPos.get(entry.pos)?.uid === entry.uid) byPos.delete(entry.pos);
      controllers.get(entry.uid)?.deactivate?.();
      setTimeout(() => timed('destroy ' + keyOf(entry.pos), () => removeEntry(entry.uid)), SLIDE_MS + 700);
    } else {
      removeEntry(entry.uid);
    }
  }
  // Mounting a slide is expensive (media elements, hls, image decode); build
  // off-screen neighbors after the transition so they don't make it stutter.
  const deferred = [];
  for (const w of want) {
    const entry = byPos.get(w.pos);
    if (!entry) {
      // Buffer slides beyond the direct neighbors always mount deferred —
      // even on a fresh (non-animated) feed start they must not delay the
      // first post.
      if ((animate && w.off !== 0) || Math.abs(w.off) > 100) {
        deferred.push(w);
        continue;
      }
      if (animate && w.off === 0 && hadSlides) {
        // Swiping faster than the deferred neighbor mount: the destination
        // isn't mounted yet. Mount it at the incoming side, commit that
        // layout, then slide it to center — otherwise it pops in place and
        // the swipe animation is lost.
        const e = timed('build ' + keyOf(w.pos), () => addEntry(w.pos, dir > 0 ? 100 : -100));
        flushSync();
        controllers.get(e.uid)?.reflow?.();
        e.off = 0;
        e.animate = true;
        continue;
      }
      timed('build ' + keyOf(w.pos), () => addEntry(w.pos, w.off)); // fresh mounts appear in place
    } else {
      entry.off = w.off;
      entry.animate = animate;
    }
  }

  P.activeUid = byPos.get(pos).uid;
  const forUid = P.activeUid;

  if (deferred.length || animate) {
    // Building a neighbor (element setup, source attach, first-frame decode)
    // is the profiled jank source when it lands near the animation — push it
    // well past the settle and stagger: the likely-next neighbor first, the
    // previous one later, image preloading last.
    const mountOne = (w) => {
      if (P.activeUid !== forUid) return; // moved on; the newer showSlide owns the window
      if (byPos.has(w.pos) || !P.posts[w.pos]) return;
      // Only the likely-next neighbor buffers fully; the prev neighbor and
      // the far-ahead buffer slides load metadata/posters, enough to land
      // on real content instead of a black frame.
      timed('deferred build ' + keyOf(w.pos), () => addEntry(w.pos, w.off, w.off === 100 ? null : 'metadata'));
    };
    // Nearest first, and at equal distance the next side before prev.
    deferred.sort((a, b) => Math.abs(a.off) - Math.abs(b.off) || b.off - a.off);
    deferred.forEach((w, i) => setTimeout(() => mountOne(w), SLIDE_MS + 250 + i * 350));
    setTimeout(() => {
      if (P.activeUid === forUid) preloadUpcoming();
    }, SLIDE_MS + 250 + deferred.length * 350);
  }

  // Render synchronously so the new slide's controller exists before
  // activation — the engine's timing then matches the old imperative app.
  flushSync();
  if (animate) profileTransition('transition', SLIDE_MS);
  timed('activate', () => activateEntry(byPos.get(pos), animate));
  if (!animate) preloadUpcoming();
}

export function next() {
  const np = P.posts[P.idx] ? nextPosOf(P.idx) : P.posts.length ? 0 : null;
  if (np == null) {
    maybePrefetch();
    if (exhausted) {
      stopSlide();
      P.message = { text: 'End of feed.' };
    } else {
      // Next page still loading; retry shortly.
      stopSlide();
      P.message = { kind: 'loading' };
      setTimeout(() => {
        if (nextPosOf(P.idx) != null) next();
        else if (exhausted) P.message = { text: 'End of feed.' };
        else setTimeout(next, 700);
      }, 700);
    }
    return;
  }
  showSlide(np, 1);
  maybePrefetch();
}

export function prev() {
  const pp = prevPosOf(P.idx);
  if (pp == null) return;
  showSlide(pp, -1);
}

function preloadUpcoming() {
  const reach = Math.max(2, (Math.round(settings.preloadCount) || 1) + 1);
  for (let i = P.idx + 1; i <= Math.min(P.idx + reach, P.posts.length - 1); i++) {
    const p = P.posts[i];
    if ((p.kind === 'image' || p.kind === 'gallery') && p.images?.[0]) {
      new Image().src = mediaUrl(p.images[0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Gallery strip: all images of a gallery post live in one slide and swipe
// along the cross axis. Returns false at the ends so callers can fall back.
// ---------------------------------------------------------------------------
function activeGalleryCtrl() {
  const c = activeController();
  return c?.galleryCount && c.galleryCount() ? c : null;
}

export function galleryStep(dir) {
  const c = activeGalleryCtrl();
  if (!c) return false;
  if (!c.galleryStep(dir)) return false;
  P.galleryIdx = c.galleryIdx();
  if (settings.autoscroll) startTimer(settings.imageSeconds); // each image gets the full duration
  return true;
}

// ---------------------------------------------------------------------------
// Tap handling (Svelte action). Single taps run their action after a short
// delay so a second tap within the window becomes a double-tap upvote
// instead. Detection uses pointer events, not click: iOS delivers click with
// variable delay and sometimes swallows the second tap's click entirely,
// making double-tap unreliable.
// ---------------------------------------------------------------------------
const DOUBLE_TAP_MS = 320;
// Hold-to-fast-forward: keeping a finger (or mouse button) down on a
// playing video runs it at 2x until release, reels-style.
const HOLD_BOOST_MS = 300;
const BOOST_RATE = 2;

// Rate changes hiccup only on videos that HAVE an audio track — track-less
// videos switch cleanly (confirmed on-device) — because the audio
// renderer's reconfigure stalls the whole pipeline. So the switch is a
// SINGLE rate assignment (a ramp is exactly wrong — every step is its own
// reconfigure; that's what made the first attempt worse) hidden inside a
// ~140ms mute blink. Pitch correction stays ON: 2x speech has to remain
// intelligible, and the DSP's engage happens while the blink is silent.
let rateMuteUntil = 0; // rescueAudio must not undo the blink mid-switch

function setRateSmooth(video, rate) {
  if (video.playbackRate === rate) return;
  if (video.muted) {
    video.playbackRate = rate;
    return;
  }
  video.muted = true;
  rateMuteUntil = Date.now() + 200;
  video.playbackRate = rate;
  setTimeout(() => {
    if (!P.muted && P.currentVideo === video && !video.paused) video.muted = false;
  }, 140);
}

export function slideTap(node, params) {
  let tapTimer = null;
  let lastTap = 0;
  let downX = 0;
  let downY = 0;
  let holdTimer = null;
  let boostEl = null; // the video element currently forced to 2x
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
  };
  const endBoost = () => {
    if (!boostEl) return false;
    setRateSmooth(boostEl, 1);
    boostEl = null;
    P.rateBoost = false;
    return true;
  };
  const onDown = (e) => {
    downX = e.clientX;
    downY = e.clientY;
    cancelHold();
    endBoost(); // a second pointer landing means pinch, not hold
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const video = P.currentVideo;
    if (P.activeUid !== params.uid || !video || video.paused) return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (P.activeUid !== params.uid || pinch || P.currentVideo !== video || video.paused) return;
      boostEl = video;
      setRateSmooth(video, BOOST_RATE);
      P.rateBoost = true;
    }, HOLD_BOOST_MS);
  };
  const onMove = (e) => {
    if (!holdTimer && !boostEl) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) {
      cancelHold();
      endBoost(); // the press became a drag
    }
  };
  const onCancel = () => {
    cancelHold();
    endBoost();
  };
  const onContextMenu = (e) => {
    // Android long-press fires contextmenu, which would kill the hold.
    if (holdTimer || boostEl) e.preventDefault();
  };
  const onUp = (e) => {
    cancelHold();
    if (endBoost()) return; // releasing a fast-forward hold is not a tap
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) return; // a drag, not a tap
    if (P.activeUid !== params.uid || clickWasScrub() || pinch || Date.now() - lastPinchEnd < 400) return;
    if (Date.now() - lastMouseDragEnd < 400) return;
    if (Date.now() - chromeDismissAt < 400) return; // the tap only closed the search panel
    const now = Date.now();
    if (now - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0;
      clearTimeout(tapTimer);
      tapTimer = null;
      doubleTapUpvote(e);
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      params.single(e);
    }, DOUBLE_TAP_MS + 30);
  };
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onCancel);
  node.addEventListener('contextmenu', onContextMenu);
  return {
    destroy() {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
      node.removeEventListener('contextmenu', onContextMenu);
      clearTimeout(tapTimer);
      cancelHold();
      endBoost();
    },
  };
}

function doubleTapUpvote(e) {
  spawnVoteBurst(e.clientX, e.clientY);
  const post = P.posts[P.idx];
  // Like Instagram/TikTok: double-tap only upvotes, never removes the vote.
  if (post && post.likes !== true) vote(1);
}

function spawnVoteBurst(x, y) {
  const el = document.createElement('div');
  el.className = 'vote-burst';
  el.textContent = '▲';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ---------------------------------------------------------------------------
// Seek by clicking/dragging the progress bar while a video plays.
// ---------------------------------------------------------------------------
let scrubbing = false;
let lastScrubEnd = 0;

// Scrub gestures can end with the pointer over the slide, making the browser
// dispatch a click there; slide tap handlers must ignore those.
function clickWasScrub() {
  return scrubbing || Date.now() - lastScrubEnd < 350;
}

function seekFromPointer(e) {
  if (!P.currentVideo || !P.currentVideo.duration || !progressEl) return;
  const rect = progressEl.getBoundingClientRect();
  let frac;
  if (barIsVertical()) {
    frac = (e.clientY - rect.top) / rect.height;
    if (settings.barInvert) frac = 1 - frac;
  } else {
    frac = (e.clientX - rect.left) / rect.width;
  }
  frac = Math.min(1, Math.max(0, frac));
  P.currentVideo.currentTime = frac * P.currentVideo.duration;
  paintFill(frac * 100 + '%');
}

export function progressPointerDown(e) {
  if (!P.seekable) return;
  e.preventDefault(); // suppress the compatibility mouse events / click
  scrubbing = true;
  progressEl.setPointerCapture(e.pointerId);
  seekFromPointer(e);
}

export function progressPointerMove(e) {
  if (scrubbing) seekFromPointer(e);
}

export function progressPointerUp() {
  scrubbing = false;
  lastScrubEnd = Date.now();
}

// Playback progress in the bottom bar (only while this slide is active).
export function videoTimeUpdate(uid, video) {
  if (P.activeUid !== uid || !video.duration || scrubbing) return;
  paintFill((video.currentTime / video.duration) * 100 + '%');
}

// With autoscroll on, videos run to the end, then advance (loop is off).
export function videoEnded(uid) {
  if (P.activeUid === uid && settings.autoscroll && !P.commentsOpen) next();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
export function openComments() {
  const post = P.posts[P.idx];
  if (!post) return;
  P.commentsPost = post;
  P.commentsOpen = true;
  pauseTimer(); // hold the autoscroll countdown while reading
}

export function closeComments() {
  if (!P.commentsOpen) return;
  P.commentsOpen = false;
  resumeTimer();
}

// ---------------------------------------------------------------------------
// Vote / save
// ---------------------------------------------------------------------------
function requireCookieAndPost() {
  const post = P.posts[P.idx];
  if (!post || !post.name) return null;
  if (!settings.cookie.trim()) {
    showToast('Set your reddit cookie in the Settings tab to vote/save');
    return null;
  }
  return post;
}

export async function vote(dir) {
  const post = requireCookieAndPost();
  if (!post) return;
  const current = post.likes === true ? 1 : post.likes === false ? -1 : 0;
  const target = current === dir ? 0 : dir; // voting the same way again clears it
  const prev = post.likes;
  post.likes = target === 1 ? true : target === -1 ? false : null;
  try {
    await api('/api/vote', { id: post.name, dir: target });
  } catch (err) {
    post.likes = prev;
    showToast('Vote failed: ' + (err.message || err));
  }
}

export async function toggleSave() {
  const post = requireCookieAndPost();
  if (!post) return;
  const prev = post.saved;
  post.saved = !prev;
  try {
    await api('/api/save', { id: post.name, save: post.saved });
    showToast(post.saved ? 'Saved' : 'Unsaved', 1500);
  } catch (err) {
    post.saved = prev;
    showToast('Save failed: ' + (err.message || err));
  }
}

// ---------------------------------------------------------------------------
// Autoscroll / mute / fill toggles
// ---------------------------------------------------------------------------
export function toggleAutoscroll() {
  settings.autoscroll = !settings.autoscroll;
  saveSettings();
  if (P.currentVideo) P.currentVideo.loop = !settings.autoscroll;
  const post = P.posts[P.idx];
  if (settings.autoscroll) {
    if (post && post.kind !== 'video') startTimer(settings.imageSeconds);
    showToast('Autoscroll on', 1200);
  } else {
    if (post && post.kind !== 'video') clearTimer();
    showToast('Autoscroll off', 1200);
  }
}

// The mute button IS the persisted "play audio" setting: on = every video
// with sound plays it, off = everything muted. It shows and flips only that
// preference — never the element's momentary (possibly policy-forced) state,
// which the gesture rescue below keeps converging to the preference.
export function toggleMute() {
  P.muted = !P.muted;
  alog(`toggle -> ${P.muted ? 'muted' : 'audio on'}`);
  if (P.currentVideo) P.currentVideo.muted = P.muted;
  if (!P.muted) {
    // The unmute tap is a definite gesture: (re)bless the pool with it.
    poolUnlocked = false;
    unlockAttempts = 0;
    lastUnlockTry = 0;
    unlockVideoPool();
  }
}

export function toggleFill() {
  settings.fillScreen = !settings.fillScreen;
  saveSettings();
}

// Any user gesture is a licence to lift a policy-forced mute — but ONLY on
// events WebKit treats as gesture-granting (touchend/click). Confirmed
// on-device: running this on pointerdown made the cycle's play() reject and
// left the video frozen.
function rescueAudio() {
  // The hold-to-2x audio blink mutes on purpose; the release gesture's
  // touchend must not "rescue" it early (its pause/play cycle would be a
  // far bigger hitch than the one the blink hides).
  if (Date.now() < rateMuteUntil) return;
  if (P.currentVideo && P.currentVideo.muted && !P.muted) {
    P.currentVideo.muted = false;
    alog('rescue: unmuted element');
    // iOS can keep a video silent after unmuting when its playback began
    // muted (stale audio session); a pause/play cycle inside the gesture
    // re-engages it — the same thing the mute-button toggle does.
    if (!P.currentVideo.paused) {
      P.currentVideo.pause();
      P.currentVideo.play().catch(() => {});
      alog('rescue: pause/play cycle');
    }
  }
}

// ---------------------------------------------------------------------------
// Sort picker: one grouped select dropdown — the flat sorts up top, then a
// group per ranged sort (top/controversial) listing its time ranges.
// ---------------------------------------------------------------------------
const SORT_TIMES = [
  { text: 'Past hour', value: 'hour' },
  { text: 'Past day', value: 'day' },
  { text: 'Past week', value: 'week' },
  { text: 'Past month', value: 'month' },
  { text: 'Past year', value: 'year' },
  { text: 'All time', value: 'all' },
];
const rangedSort = (base) => SORT_TIMES.map((t) => ({ text: t.text, value: `${base}:${t.value}` }));

// 'default' stands in for the empty sort: a Select treats '' as "nothing
// selected", which would leave Default permanently uncheckable.
export const SORT_SECTIONS = [
  {
    label: null,
    items: [
      { text: 'Default', value: 'default' },
      { text: 'Hot', value: 'hot' },
      { text: 'New', value: 'new' },
      { text: 'Rising', value: 'rising' },
    ],
  },
  { label: 'Top', items: rangedSort('top') },
  { label: 'Controversial', items: rangedSort('controversial') },
];

export function sortLabel(s) {
  if (!s) return 'Sort';
  const [b, t] = s.split(':');
  const cap = b.charAt(0).toUpperCase() + b.slice(1);
  return t ? `${cap} · ${t === 'all' ? 'all time' : t}` : cap;
}

export function setSort(v) {
  const sort = !v || v === 'default' ? '' : v;
  if (sort === settings.sort) return;
  settings.sort = sort;
  saveSettings();
  if (P.feedActive) startFeed(P.feedInput.trim() || settings.lastFeed);
}

// ---------------------------------------------------------------------------
// Pinch-zoom: two fingers zoom the active post's media only — the shell
// (top bar, meta, progress bar) stays put, like Instagram. The zoom is
// transient: releasing springs the media back to its normal size.
// ---------------------------------------------------------------------------
let pinch = null;
let lastPinchEnd = 0;

function activeMedia() {
  const c = activeController();
  return c?.media ? c.media() : null; // { el, setZooming } or null
}

function beginPinch(touches) {
  const media = activeMedia();
  if (!media) return;
  const [a, b] = touches;
  const rect = media.el.getBoundingClientRect();
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;
  pinch = {
    media,
    el: media.el,
    dist0: Math.max(20, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
    midX0: midX,
    midY0: midY,
  };
  media.el.style.transition = 'none';
  media.el.style.transformOrigin = `${midX - rect.left}px ${midY - rect.top}px`;
  media.setZooming(true);
}

function movePinch(touches) {
  const [a, b] = touches;
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const scale = Math.min(5, Math.max(1, dist / pinch.dist0));
  const dx = (a.clientX + b.clientX) / 2 - pinch.midX0;
  const dy = (a.clientY + b.clientY) / 2 - pinch.midY0;
  pinch.el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
}

function endPinch() {
  const { media, el } = pinch;
  pinch = null;
  lastPinchEnd = Date.now();
  el.style.transition = 'transform 0.25s ease-out';
  el.style.transform = '';
  setTimeout(() => {
    el.style.transition = '';
    el.style.transformOrigin = '';
    media.setZooming(false);
  }, 300);
}

// ---------------------------------------------------------------------------
// Swipe/drag gestures (touch fingers and mouse drags share this logic).
// Along the feed axis the whole slide window follows the pointer (the
// neighbor post peeks in); along the cross axis the active gallery's strip
// follows it. Whichever axis dominates the first significant movement wins
// for the rest of the gesture.
// ---------------------------------------------------------------------------
let touchStartX = 0;
let touchStartY = 0;
let dragMode = null; // null | 'main' | 'gallery'
let canDrag = false;
let chromeDismissAt = 0; // last gesture spent on closing the search panel
// A gesture that must not navigate at all — canDrag=false alone isn't
// enough, because gestureEnd's flick fallback fires on plain distance.
let suppressGesture = false;

function gestureBegin(x, y, target, isTouch = false) {
  touchStartX = x;
  touchStartY = y;
  dragMode = null;
  suppressGesture = false;
  // While the search field is focused (suggestion panel open, keyboard up
  // on phones) the first gesture on the feed dismisses that UI instead of
  // navigating — swipes during the keyboard's resize dance land somewhere
  // unpredictable. The next gesture behaves normally.
  if (feedInputEl && document.activeElement === feedInputEl) {
    feedInputEl.blur();
    chromeDismissAt = Date.now();
    suppressGesture = true;
    canDrag = false;
    return;
  }
  canDrag =
    settings.smoothScroll &&
    P.window.length > 0 &&
    // Scrollable reading surfaces own their touches (an expanded title or
    // caption scrolls its overflow just like a text post's body).
    !target.closest('.text-post, #meta-title.expanded, #meta-body.expanded') &&
    // Touches starting at the screen edge belong to history back/forward.
    !(isTouch && (x <= EDGE_SWIPE_PX || x >= window.innerWidth - EDGE_SWIPE_PX));
}

function gestureMove(x, y) {
  if (!canDrag) return;
  const dx = x - touchStartX;
  const dy = y - touchStartY;
  const main = settings.vertical ? dy : dx;
  const cross = settings.vertical ? dx : dy;
  if (!dragMode && (Math.abs(main) > 10 || Math.abs(cross) > 10)) {
    dragMode = Math.abs(main) >= Math.abs(cross) ? 'main' : activeGalleryCtrl() ? 'gallery' : null;
  }
  if (dragMode === 'main') {
    P.dragging = true;
    P.dragPx = main;
  } else if (dragMode === 'gallery') {
    P.galleryDragging = true;
    P.galleryDragPx = cross;
  }
}

// Returns true when the gesture engaged a drag (used to suppress the click
// browsers fire after a mouse drag).
function gestureEnd(x, y) {
  if (suppressGesture) {
    suppressGesture = false;
    dragMode = null;
    canDrag = false;
    return false;
  }
  const dx = x - touchStartX;
  const dy = y - touchStartY;
  const main = settings.vertical ? dy : dx;
  const cross = settings.vertical ? dx : dy;
  const mode = dragMode;
  dragMode = null;
  canDrag = false;

  if (mode === 'gallery') {
    P.galleryDragging = false;
    P.galleryDragPx = 0;
    // Step if the swipe was far enough and the strip has room; else snap
    // (dropping the drag offset with the transition on IS the snap).
    if (Math.abs(cross) >= 60) galleryStep(cross < 0 ? 1 : -1);
    return true;
  }

  const fired = Math.abs(main) >= 60 && Math.abs(main) >= Math.abs(cross) * 1.5;
  if (mode === 'main') {
    // Snap everything back; a completed swipe immediately re-targets the
    // window from the dragged position, so the transition continues on.
    for (const entry of P.window) {
      if (!entry.evicted) entry.animate = true;
    }
    P.dragging = false;
    P.dragPx = 0;
  }
  if (fired) {
    // Swiping up/left pulls the next slide in; down/right goes back.
    if (main < 0) next();
    else prev();
  }
  return mode !== null;
}

function abortDragForPinch() {
  // Second finger: abort any in-progress drag and start pinching.
  if (dragMode === 'main') {
    for (const entry of P.window) {
      if (!entry.evicted) entry.animate = true;
    }
    P.dragging = false;
    P.dragPx = 0;
  } else if (dragMode === 'gallery') {
    P.galleryDragging = false;
    P.galleryDragPx = 0;
  }
  dragMode = null;
  canDrag = false;
}

export function viewerTouchStart(e) {
  if (e.touches.length >= 2) {
    abortDragForPinch();
    if (!pinch) beginPinch(e.touches);
    return;
  }
  gestureBegin(e.touches[0].clientX, e.touches[0].clientY, e.target, true);
}

export function viewerTouchMove(e) {
  if (pinch) {
    if (e.touches.length >= 2) movePinch(e.touches);
    return;
  }
  gestureMove(e.touches[0].clientX, e.touches[0].clientY);
}

export function viewerTouchEnd(e) {
  if (pinch) {
    if (e.touches.length < 2) endPinch();
    return;
  }
  if (Date.now() - lastPinchEnd < 300) return; // ignore the pinch's tail
  gestureEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
}

// Mouse drags navigate too (posts along the feed axis, galleries across it).
let mouseDragging = false;
let lastMouseDragEnd = 0;

// Lets click handlers on gesture surfaces (e.g. the tap-to-expand title)
// ignore the click a mouse drag leaves behind.
export function recentDragEnd() {
  return Date.now() - lastMouseDragEnd < 400;
}

export function viewerPointerDown(e) {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  mouseDragging = true;
  gestureBegin(e.clientX, e.clientY, e.target);
}

// ---------------------------------------------------------------------------
// Tabs. Opening settings holds the feed (video + countdown) until you leave.
// ---------------------------------------------------------------------------
let settingsPausedPlayback = false;

export function showTab(tab) {
  P.tab = tab;
  if (tab === 'settings') {
    // hold the feed while in settings
    if (P.currentVideo && !P.currentVideo.paused) {
      P.currentVideo.pause();
      settingsPausedPlayback = true;
    }
    pauseTimer();
  } else {
    if (settingsPausedPlayback) {
      settingsPausedPlayback = false;
      P.currentVideo?.play().catch(() => {});
    }
    resumeTimer();
  }
}

// Mounted neighbor slides carry transforms sized for the old axis; re-place
// the window after the navigation axis flips (the transforms themselves
// re-derive reactively).
export function refreshAfterVerticalChange() {
  if (P.activeUid == null) return;
  const entry = P.window.find((e) => e.uid === P.activeUid);
  if (entry) showSlide(entry.pos, 0);
}

// ---------------------------------------------------------------------------
// Global listeners + startup (called once from App onMount).
// ---------------------------------------------------------------------------
const EDGE_SWIPE_PX = 28;
const EDGE_BAND = 32;
let feedInputEl = null;
let initialized = false;

export function registerFeedInput(el) {
  feedInputEl = el;
}

// Standalone iOS can end the shell short of the physical screen bottom (the
// layout viewport stops above the home indicator) while
// env(safe-area-inset-bottom) still reports the inset — padding with raw
// env() then pads for space the shell never covers. Measure where #app
// ACTUALLY ends versus the screen and publish the shortfall for the CSS to
// subtract (--safe-bottom). When the standalone 100vh sizing reclaims the
// full screen this measures 0 and the normal safe-area padding applies;
// when the shell stays short, the padding shrinks by exactly the shortfall.
// iOS reports screen dimensions portrait-fixed, so compare against the axis
// that currently runs vertically.
function syncBottomLetterbox() {
  let gap = 0;
  const standalone =
    navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches;
  const app = document.getElementById('app');
  if (standalone && window.screen && app) {
    const landscape = window.innerWidth > window.innerHeight;
    const screenH = landscape
      ? Math.min(screen.width, screen.height)
      : Math.max(screen.width, screen.height);
    gap = Math.max(0, Math.round(screenH - app.getBoundingClientRect().bottom));
  }
  document.documentElement.style.setProperty('--bottom-letterbox', gap + 'px');
}

export function initPlayer() {
  if (initialized) return;
  initialized = true;

  syncBottomLetterbox();
  requestAnimationFrame(syncBottomLetterbox); // re-measure once layout settles
  setTimeout(syncBottomLetterbox, 800);
  window.addEventListener('resize', syncBottomLetterbox);
  window.visualViewport?.addEventListener('resize', syncBottomLetterbox);
  window.addEventListener('orientationchange', () => setTimeout(syncBottomLetterbox, 300));

  document.addEventListener('touchend', unlockVideoPool, { capture: true, passive: true });
  document.addEventListener('click', unlockVideoPool, { capture: true, passive: true });
  document.addEventListener('touchend', rescueAudio, { capture: true, passive: true });
  document.addEventListener('click', rescueAudio, { capture: true, passive: true });

  // Keep the app off the lock screen / control center media widget: neuter
  // the media-session controls, and when the app backgrounds, pause playback
  // and clear the session (iOS otherwise keeps a stale now-playing card
  // around). Playback resumes when the app returns.
  if ('mediaSession' in navigator) {
    for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack']) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* action not supported here */
      }
    }
  }

  let pausedByHide = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (P.currentVideo && !P.currentVideo.paused) {
        P.currentVideo.pause();
        pausedByHide = true;
      }
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = null;
          navigator.mediaSession.playbackState = 'none';
        } catch {
          /* ignore */
        }
      }
    } else if (pausedByHide) {
      pausedByHide = false;
      P.currentVideo?.play().catch(() => {});
    }
  });

  window.addEventListener('popstate', (e) => {
    lastPopstateAt = Date.now();
    const st = e.state;
    if (!st || typeof st.feed !== 'string') return;
    P.feedInput = st.feed;
    if (typeof st.sort === 'string') {
      settings.sort = st.sort;
      saveSettings();
    }
    startFeed(st.feed, st.name ? { cursor: st.cursor || '', name: st.name } : null);
  });

  // Mouse drag tracking outside the viewer.
  window.addEventListener('pointermove', (e) => {
    if (!mouseDragging || e.pointerType !== 'mouse') return;
    gestureMove(e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', (e) => {
    if (!mouseDragging || e.pointerType !== 'mouse') return;
    mouseDragging = false;
    if (gestureEnd(e.clientX, e.clientY)) lastMouseDragEnd = Date.now();
  });

  // In automatic bar mode, a tap near a screen edge docks the progress bar
  // there. Runs in the capture phase and swallows the tap so the slide's
  // pause handler and the nav zones don't also react; real controls
  // (topbar buttons, vote/save, the bar itself) keep priority.
  document.addEventListener(
    'click',
    (e) => {
      if (settings.barMode !== 'auto' || P.tab === 'settings') return;
      if (
        e.target.closest(
          'button:not(.nav-zone), input, select, textarea, a, dialog, #progress, #meta-actions, ' +
            '[role="dialog"], [role="listbox"], .toast'
        )
      )
        return;
      let pos = null;
      // The top edge is mostly covered by the feed input on phones, so any
      // tap on the top bar's empty background counts as the top edge too.
      if (e.clientY <= EDGE_BAND || e.target.closest('#topbar')) pos = 'top';
      else if (e.clientY >= window.innerHeight - EDGE_BAND) pos = 'bottom';
      else if (e.clientX <= EDGE_BAND) pos = 'left';
      else if (e.clientX >= window.innerWidth - EDGE_BAND) pos = 'right';
      if (!pos || pos === settings.barPos) return;
      e.preventDefault();
      e.stopPropagation();
      settings.barPos = pos;
      saveSettings();
      showToast('Progress bar → ' + pos, 1200);
    },
    true
  );

  // Swipe inward from the left/right screen edge for history back/forward
  // (iOS standalone PWAs don't provide the native browser gesture).
  let edgeSwipe = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      // With the keyboard up (any text field focused) a stray edge touch
      // must not navigate history out from under the search UI.
      const ae = document.activeElement;
      const editing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      if (e.touches.length !== 1 || P.tab === 'settings' || P.commentsOpen || editing) {
        edgeSwipe = null;
        return;
      }
      const { clientX: x, clientY: y } = e.touches[0];
      edgeSwipe =
        x <= EDGE_SWIPE_PX
          ? { side: 'left', x, y }
          : x >= window.innerWidth - EDGE_SWIPE_PX
            ? { side: 'right', x, y }
            : null;
    },
    { passive: true, capture: true }
  );
  document.addEventListener(
    'touchend',
    (e) => {
      if (!edgeSwipe) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - edgeSwipe.x;
      const dy = t.clientY - edgeSwipe.y;
      const side = edgeSwipe.side;
      edgeSwipe = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
      // Newer iOS handles this gesture natively (a popstate arrives on its
      // own); navigating here too would race it and bounce the feed back.
      // Only act if no history navigation happens right after the swipe.
      const marker = lastPopstateAt;
      setTimeout(() => {
        if (lastPopstateAt !== marker) return; // the platform already navigated
        if (side === 'left' && dx > 0) history.back();
        else if (side === 'right' && dx < 0) history.forward();
      }, 350);
    },
    { passive: true, capture: true }
  );
  // WebKit converts touches to touchcancel when a system gesture takes over.
  document.addEventListener(
    'touchcancel',
    () => {
      edgeSwipe = null;
    },
    { passive: true, capture: true }
  );

  // Mouse wheel / trackpad: vertical scroll moves between posts; horizontal
  // scroll steps through the active gallery (when the gallery is horizontal).
  let wheelLockUntil = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (P.tab === 'settings' || P.commentsOpen) return;
      // Scrolling over the top bar (feed input, suggestion panel) is for
      // that UI, never for flipping posts.
      if (e.target instanceof Element && e.target.closest('#topbar')) return;
      const now = Date.now();
      if (now < wheelLockUntil) return;
      if (settings.vertical && Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) >= 20) {
        if (galleryStep(e.deltaX > 0 ? 1 : -1)) wheelLockUntil = now + 400;
        return;
      }
      if (Math.abs(e.deltaY) < 20) return;
      wheelLockUntil = now + 500;
      if (e.deltaY > 0) next();
      else prev();
    },
    { passive: true }
  );

  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    if (ae === feedInputEl || (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'))) return;
    // An open select dropdown owns Escape — it must close the dropdown, not
    // leave the settings tab or dismiss the comments sheet underneath.
    if (e.key === 'Escape' && document.querySelector('[data-select-content]')) return;
    if (P.tab === 'settings') {
      if (e.key === 'Escape') showTab('posts');
      return;
    }
    if (P.commentsOpen) {
      if (e.key === 'Escape' || e.key === 'c') closeComments();
      return; // don't navigate the feed under the panel
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        toggleAutoscroll();
        break;
      // Arrows on the main axis move between posts; arrows on the cross axis
      // step through the active gallery (falling back to posts otherwise).
      case 'ArrowRight':
        if (settings.vertical && galleryStep(1)) break;
        next();
        break;
      case 'ArrowLeft':
        if (settings.vertical && galleryStep(-1)) break;
        prev();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!settings.vertical && galleryStep(1)) break;
        next();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!settings.vertical && galleryStep(-1)) break;
        prev();
        break;
      case 'j':
        next();
        break;
      case 'k':
        prev();
        break;
      case 'm':
        toggleMute();
        break;
      case 'f':
        toggleFill();
        break;
      case 'a':
        vote(1);
        break;
      case 'z':
        vote(-1);
        break;
      case 's':
        toggleSave();
        break;
      case 'c':
        openComments();
        break;
    }
  });

  // iOS scrolls the document when the on-screen keyboard opens and doesn't
  // always scroll back when it closes. The app is position-fixed so nothing
  // looks wrong, but hit-testing stays offset by the leftover scroll — taps
  // then land on the element above their visual position. Snap the scroll
  // back whenever an input loses focus or the visual viewport changes.
  function resetViewportScroll() {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
    if (document.body.scrollTop) document.body.scrollTop = 0;
  }
  document.addEventListener('focusout', () => setTimeout(resetViewportScroll, 60));
  window.visualViewport?.addEventListener('resize', () => setTimeout(resetViewportScroll, 60));
  window.addEventListener('orientationchange', () => setTimeout(resetViewportScroll, 250));
  // The on-screen keyboard overlays the layout viewport, so a scroller whose
  // bottom sits under it can never reach its last rows. Measure the overlap
  // into --kb-inset; the scrollers pad their ends by it.
  const syncKeyboardInset = () => {
    const vv = window.visualViewport;
    const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--kb-inset', Math.round(inset) + 'px');
  };
  window.visualViewport?.addEventListener('resize', syncKeyboardInset);
  window.visualViewport?.addEventListener('scroll', syncKeyboardInset);
  syncKeyboardInset();
  // The standalone shell is 100vh — taller than iOS's cut-short layout
  // viewport — so the document is technically scrollable by the difference,
  // and anything that scrolls it (focus reveals, scrollIntoView) shifts the
  // whole app up. The app never scrolls the document on purpose; clamp it.
  window.addEventListener(
    'scroll',
    () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    },
    { passive: true }
  );
  // With the keyboard up the occluded half makes the document genuinely
  // scrollable, and iOS pans the whole shell on any drag — the clamp above
  // only snaps it back afterwards, which reads as a broken feed swipe.
  // While an editable element has focus, kill viewport panning at the
  // source; touches inside surfaces that really scroll keep working.
  document.addEventListener(
    'touchmove',
    (e) => {
      const ae = document.activeElement;
      const editing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      // The dismissing gesture itself blurs on touchstart, and the keyboard
      // takes a beat to animate away — keep blocking through that window.
      if (!editing && Date.now() - chromeDismissAt > 700) return;
      if (e.target instanceof Element) {
        // These must be the elements that actually scroll — #settings-page
        // itself is overflow:hidden (the form inside it scrolls), so
        // matching it would fail the overflow test and freeze the page
        // while the keyboard is up.
        const scroller = e.target.closest(
          '#suggest .sg-body, #suggest .sg-chips, #settings-form, #comments-list, .as-group, textarea'
        );
        // Either axis counts: the chip row overflows horizontally.
        if (
          scroller &&
          (scroller.scrollHeight > scroller.clientHeight + 1 ||
            scroller.scrollWidth > scroller.clientWidth + 1)
        )
          return;
      }
      e.preventDefault();
    },
    { passive: false }
  );

  // Resume the last session's feed and position.
  const r = settings.resume;
  if (r && typeof r.path === 'string' && r.name) {
    P.feedInput = r.path;
    if (typeof r.sort === 'string') settings.sort = r.sort;
    startFeed(r.path, r);
  }
}
