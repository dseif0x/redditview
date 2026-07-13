import Hls from 'hls.js';
import './style.css';

// ---------------------------------------------------------------------------
// Settings (localStorage only)
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'redditview.settings';
const DEFAULTS = {
  cookie: '',
  imageSeconds: 8,
  startMuted: false,
  lastFeed: '',
  showImages: true,
  showVideos: true,
  showText: true,
  fillScreen: false,
  vertical: false,
};

let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
} catch {
  /* corrupted storage -> defaults */
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let posts = [];
let after = null;
let exhausted = false;
let loading = false;
let feedPath = '';
let feedActive = false;

let idx = -1;
let galleryIdx = 0;
let paused = false;
let muted = settings.startMuted;

let timerId = null;
let timerStartedAt = 0;
let timerRemainingMs = 0;

let hls = null;
let currentVideo = null;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const viewer = $('#viewer');
const emptyState = $('#empty-state');
const feedForm = $('#feed-form');
const feedInput = $('#feed-input');
const pauseBtn = $('#pause-btn');
const muteBtn = $('#mute-btn');
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsForm = $('#settings-form');
const cookieInput = $('#cookie-input');
const imageSecondsInput = $('#image-seconds-input');
const startMutedInput = $('#start-muted-input');
const showImagesInput = $('#show-images-input');
const showVideosInput = $('#show-videos-input');
const showTextInput = $('#show-text-input');
const fillScreenInput = $('#fill-screen-input');
const verticalInput = $('#vertical-input');
const fillBtn = $('#fill-btn');
const appEl = $('#app');
const prevZone = $('#prev-zone');
const nextZone = $('#next-zone');
const progressFill = $('#progress-fill');
const meta = $('#meta');
const metaTitle = $('#meta-title');
const metaSub = $('#meta-sub');
const upBtn = $('#up-btn');
const downBtn = $('#down-btn');
const saveBtn = $('#save-btn');
const toast = $('#toast');

feedInput.value = settings.lastFeed;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PROXIED_HOSTS = ['redd.it', 'redditmedia.com', 'redditstatic.com', 'imgur.com', 'redgifs.com'];

// Route media through the backend proxy when it lives on a reddit/imgur CDN
// (CORS + hotlinking); anything else loads directly.
function mediaUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (PROXIED_HOSTS.some((d) => host === d || host.endsWith('.' + d))) {
      return '/api/media?u=' + encodeURIComponent(u);
    }
  } catch {
    /* relative or malformed -> use as-is */
  }
  return u;
}

let toastTimer = null;
function showToast(msg, ms = 4000) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Feed loading
// ---------------------------------------------------------------------------
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
  if (loading || exhausted) return;
  loading = true;
  try {
    // A page may contain only filtered-out kinds; keep paging (bounded) until
    // something usable shows up.
    for (let attempts = 0; attempts < 5; attempts++) {
      const params = new URLSearchParams({ path: feedPath });
      if (after) params.set('after', after);
      const headers = {};
      if (settings.cookie.trim()) headers['X-Reddit-Cookie'] = settings.cookie.trim();

      const res = await fetch('/api/feed?' + params.toString(), { headers });
      if (!res.ok) {
        throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const added = data.posts.filter(kindEnabled);
      posts.push(...added);
      after = data.after || null;
      if (!after) {
        exhausted = true;
        break;
      }
      if (added.length > 0) break;
    }
  } finally {
    loading = false;
  }
}

async function startFeed(path) {
  stopSlide();
  posts = [];
  after = null;
  exhausted = false;
  idx = -1;
  feedPath = path;
  feedActive = true;
  settings.lastFeed = path;
  saveSettings();

  emptyState?.remove();
  viewer.innerHTML = '<div class="loading">loading…</div>';
  meta.hidden = true;

  try {
    await fetchPage();
  } catch (err) {
    viewer.innerHTML = `<div class="loading error">Failed to load feed:<br>${escapeHtml(String(err.message || err))}</div>`;
    return;
  }
  if (posts.length === 0) {
    viewer.innerHTML = '<div class="loading">No viewable posts in this feed.</div>';
    return;
  }
  next();
}

function maybePrefetch() {
  if (idx >= posts.length - 5 && !exhausted && !loading) {
    fetchPage().catch((err) => showToast('Failed to load more: ' + err.message));
  }
}

// ---------------------------------------------------------------------------
// Timer (images / galleries / text) with progress bar
// ---------------------------------------------------------------------------
function startTimer(seconds) {
  clearTimer();
  timerRemainingMs = seconds * 1000;
  progressFill.style.transition = 'none';
  progressFill.style.width = '0%';
  // Force reflow so the width reset applies before the transition starts.
  void progressFill.offsetWidth;
  if (!paused) runTimer();
}

function runTimer() {
  timerStartedAt = Date.now();
  timerId = setTimeout(onTimerDone, timerRemainingMs);
  progressFill.style.transition = `width ${timerRemainingMs}ms linear`;
  progressFill.style.width = '100%';
}

function pauseTimer() {
  if (timerId == null) return;
  clearTimeout(timerId);
  timerId = null;
  timerRemainingMs = Math.max(0, timerRemainingMs - (Date.now() - timerStartedAt));
  const w = getComputedStyle(progressFill).width;
  progressFill.style.transition = 'none';
  progressFill.style.width = w;
}

function clearTimer() {
  clearTimeout(timerId);
  timerId = null;
  timerRemainingMs = 0;
  progressFill.style.transition = 'none';
  progressFill.style.width = '0%';
}

function onTimerDone() {
  timerId = null;
  const post = posts[idx];
  if (post && post.kind === 'gallery' && galleryIdx < post.images.length - 1) {
    galleryIdx++;
    renderSlide();
  } else {
    next();
  }
}

// ---------------------------------------------------------------------------
// Slide rendering
// ---------------------------------------------------------------------------
function stopSlide() {
  clearTimer();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (currentVideo) {
    currentVideo.pause();
    currentVideo.removeAttribute('src');
    currentVideo = null;
  }
}

function next() {
  if (idx >= posts.length - 1) {
    maybePrefetch();
    if (idx >= posts.length - 1) {
      if (exhausted) {
        stopSlide();
        viewer.innerHTML = '<div class="loading">End of feed.</div>';
        meta.hidden = true;
      } else {
        // Next page still loading; retry shortly.
        stopSlide();
        viewer.innerHTML = '<div class="loading">loading…</div>';
        setTimeout(() => {
          if (idx < posts.length - 1) next();
          else if (exhausted) viewer.innerHTML = '<div class="loading">End of feed.</div>';
          else setTimeout(next, 700);
        }, 700);
      }
      return;
    }
  }
  idx++;
  galleryIdx = 0;
  renderSlide();
  maybePrefetch();
}

function prev() {
  if (idx <= 0) return;
  idx--;
  galleryIdx = 0;
  renderSlide();
}

function renderSlide() {
  stopSlide();
  const post = posts[idx];
  if (!post) return;

  viewer.innerHTML = '';
  const slide = document.createElement('div');
  slide.className = 'slide';

  switch (post.kind) {
    case 'video':
      renderVideo(slide, post);
      break;
    case 'gallery':
    case 'image':
      renderImage(slide, post);
      break;
    case 'text':
      renderText(slide, post);
      break;
  }

  viewer.appendChild(slide);
  renderMeta(post);
  preloadUpcoming();
}

function renderImage(slide, post) {
  const src = post.images[post.kind === 'gallery' ? galleryIdx : 0];
  const img = document.createElement('img');
  img.src = mediaUrl(src);
  img.alt = post.title;
  img.addEventListener('error', () => {
    showToast('Image failed to load, skipping');
    setTimeout(next, 800);
  });
  slide.appendChild(img);
  startTimer(settings.imageSeconds);
}

function renderText(slide, post) {
  const box = document.createElement('div');
  box.className = 'text-post';
  const h = document.createElement('h2');
  h.textContent = post.title;
  box.appendChild(h);
  if (post.text) {
    const body = document.createElement('p');
    body.textContent = post.text.length > 2000 ? post.text.slice(0, 2000) + '…' : post.text;
    box.appendChild(body);
  }
  slide.appendChild(box);
  startTimer(settings.imageSeconds);
}

// Reddit's transcode of redgifs posts has no audio; ask the backend to
// resolve the real (signed, expiring) redgifs mp4 first.
async function resolveRedgifs(post) {
  try {
    const res = await fetch('/api/redgifs?id=' + encodeURIComponent(post.redgifsId));
    if (res.ok) {
      const data = await res.json();
      if (data.mp4) {
        post.redgifsMp4 = data.mp4;
        if (!post.poster && data.poster) post.poster = data.poster;
        return;
      }
    }
  } catch {
    /* fall through to reddit's silent transcode */
  }
  showToast('redgifs lookup failed — playing silent reddit preview');
}

function renderVideo(slide, post) {
  if (post.redgifsId && !post.redgifsMp4 && !post.redgifsResolved) {
    post.redgifsResolved = true;
    const spinner = document.createElement('div');
    spinner.className = 'loading';
    spinner.textContent = 'loading…';
    slide.appendChild(spinner);
    resolveRedgifs(post).then(() => {
      if (posts[idx] === post && slide.isConnected) {
        slide.innerHTML = '';
        renderVideo(slide, post);
      }
    });
    return;
  }

  // Sources in preference order; on failure fall through to the next.
  const sources = [];
  if (post.redgifsMp4) sources.push({ type: 'mp4', url: post.redgifsMp4 });
  if (post.videoHls) sources.push({ type: 'hls', url: post.videoHls });
  if (post.videoMp4) sources.push({ type: 'mp4', url: post.videoMp4, silent: !!post.videoHls });
  let si = -1;

  const video = document.createElement('video');
  video.playsInline = true;
  video.autoplay = true;
  video.muted = muted;
  if (post.poster) video.poster = mediaUrl(post.poster);

  const attemptPlay = () => {
    // Autoplay with sound is often blocked before user interaction: fall back
    // to muted playback rather than stalling the feed.
    video
      .play()
      .then(() => addUnmuteOverlay(slide, video))
      .catch(() => {
        if (!video.muted) {
          video.muted = true;
          updateMuteBtn();
          video.play().catch(() => {});
        }
        addUnmuteOverlay(slide, video);
      });
  };

  const loadNextSource = (why) => {
    if (si >= 0) console.warn('video source failed:', sources[si]?.url, why);
    si++;
    const s = sources[si];
    if (!s) {
      showToast(`Video failed (${why}), skipping`);
      setTimeout(next, 800);
      return;
    }
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (s.type === 'hls') {
      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 20 });
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (data.fatal) loadNextSource(data.type);
        });
        hls.loadSource(mediaUrl(s.url));
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = mediaUrl(s.url);
      } else {
        loadNextSource('hls unsupported');
        return;
      }
    } else {
      // reddit's fallback mp4 is video-only; explain the silence.
      if (s.silent) showToast('Video stream failed — using fallback (no audio)');
      video.src = mediaUrl(s.url);
    }
    attemptPlay();
  };

  // Videos run to the end, then advance.
  video.addEventListener('ended', () => next());
  video.addEventListener('error', () => loadNextSource('playback error'));
  video.addEventListener('play', () => {
    if (paused) video.pause();
  });
  video.addEventListener('click', () => togglePause());

  currentVideo = video;
  slide.appendChild(video);
  loadNextSource('start');
}

// A prominent tap-for-sound button whenever a video is playing muted, since
// browsers routinely force autoplay to start muted.
function addUnmuteOverlay(slide, video) {
  if (currentVideo !== video || !video.muted) return;
  const btn = document.createElement('button');
  btn.className = 'unmute-overlay';
  btn.textContent = '🔊 Tap for sound';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    video.muted = false;
    muted = false;
    updateMuteBtn();
    video.play().catch(() => {});
  });
  video.addEventListener('volumechange', () => {
    if (!video.muted) btn.remove();
  });
  slide.appendChild(btn);
}

function renderMeta(post) {
  meta.hidden = false;
  metaTitle.textContent = post.title;
  const parts = [
    `${idx + 1}/${posts.length}${exhausted ? '' : '+'}`,
    post.subreddit,
    post.author ? `u/${post.author}` : null,
    post.nsfw ? 'NSFW' : null,
    post.kind === 'gallery' ? `${galleryIdx + 1}/${post.images.length}` : null,
  ].filter(Boolean);
  metaSub.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = parts.join(' · ') + ' · ';
  const link = document.createElement('a');
  link.href = post.permalink;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'open ↗';
  metaSub.append(span, link);
  updateActionButtons(post);
}

// ---------------------------------------------------------------------------
// Vote / save
// ---------------------------------------------------------------------------
function updateActionButtons(post) {
  upBtn.classList.toggle('active-up', post.likes === true);
  downBtn.classList.toggle('active-down', post.likes === false);
  saveBtn.classList.toggle('active-save', !!post.saved);
  saveBtn.textContent = post.saved ? '★' : '☆';
}

function actionHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Reddit-Cookie': settings.cookie.trim(),
  };
}

function requireCookieAndPost() {
  const post = posts[idx];
  if (!post || !post.name) return null;
  if (!settings.cookie.trim()) {
    showToast('Set your reddit cookie in ⚙ settings to vote/save');
    return null;
  }
  return post;
}

async function vote(dir) {
  const post = requireCookieAndPost();
  if (!post) return;
  const current = post.likes === true ? 1 : post.likes === false ? -1 : 0;
  const target = current === dir ? 0 : dir; // voting the same way again clears it
  const prev = post.likes;
  post.likes = target === 1 ? true : target === -1 ? false : null;
  updateActionButtons(post);
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: actionHeaders(),
      body: JSON.stringify({ id: post.name, dir: target }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 150));
  } catch (err) {
    post.likes = prev;
    if (posts[idx] === post) updateActionButtons(post);
    showToast('Vote failed: ' + (err.message || err));
  }
}

async function toggleSave() {
  const post = requireCookieAndPost();
  if (!post) return;
  const prev = post.saved;
  post.saved = !prev;
  updateActionButtons(post);
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: actionHeaders(),
      body: JSON.stringify({ id: post.name, save: post.saved }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 150));
    showToast(post.saved ? 'Saved' : 'Unsaved', 1500);
  } catch (err) {
    post.saved = prev;
    if (posts[idx] === post) updateActionButtons(post);
    showToast('Save failed: ' + (err.message || err));
  }
}

function preloadUpcoming() {
  for (let i = idx + 1; i <= Math.min(idx + 2, posts.length - 1); i++) {
    const p = posts[i];
    if ((p.kind === 'image' || p.kind === 'gallery') && p.images?.[0]) {
      new Image().src = mediaUrl(p.images[0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Pause / mute
// ---------------------------------------------------------------------------
function togglePause() {
  paused = !paused;
  pauseBtn.textContent = paused ? '▶' : '⏸';
  pauseBtn.classList.toggle('active', paused);
  if (paused) {
    pauseTimer();
    currentVideo?.pause();
  } else {
    if (timerRemainingMs > 0) runTimer();
    currentVideo?.play().catch(() => {});
  }
}

function applyFill() {
  viewer.classList.toggle('fill', settings.fillScreen);
  fillBtn.classList.toggle('active', settings.fillScreen);
}

function applyDirection() {
  appEl.classList.toggle('vertical', settings.vertical);
  prevZone.textContent = settings.vertical ? '⌃' : '‹';
  nextZone.textContent = settings.vertical ? '⌄' : '›';
  prevZone.title = settings.vertical ? 'Previous (↑)' : 'Previous (←)';
  nextZone.title = settings.vertical ? 'Next (↓)' : 'Next (→)';
}

function toggleFill() {
  settings.fillScreen = !settings.fillScreen;
  saveSettings();
  applyFill();
}

function toggleMute() {
  muted = !muted;
  if (currentVideo) currentVideo.muted = muted;
  updateMuteBtn();
}

function updateMuteBtn() {
  if (currentVideo) muted = currentVideo.muted;
  muteBtn.textContent = muted ? '🔇' : '🔊';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
feedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  feedInput.blur();
  startFeed(feedInput.value.trim());
});

pauseBtn.addEventListener('click', togglePause);
muteBtn.addEventListener('click', toggleMute);
fillBtn.addEventListener('click', toggleFill);
nextZone.addEventListener('click', next);
prevZone.addEventListener('click', prev);
upBtn.addEventListener('click', () => vote(1));
downBtn.addEventListener('click', () => vote(-1));
saveBtn.addEventListener('click', toggleSave);

// Swipe gestures: swipe toward the next slide along the configured axis.
let touchStartX = 0;
let touchStartY = 0;
viewer.addEventListener(
  'touchstart',
  (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  },
  { passive: true }
);
viewer.addEventListener(
  'touchend',
  (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const main = settings.vertical ? dy : dx;
    const cross = settings.vertical ? dx : dy;
    if (Math.abs(main) < 60 || Math.abs(main) < Math.abs(cross) * 1.5) return;
    // Swiping up/left pulls the next slide in; down/right goes back.
    if (main < 0) next();
    else prev();
  },
  { passive: true }
);

// Mouse wheel / trackpad: scroll down for next, up for previous.
let wheelLockUntil = 0;
window.addEventListener(
  'wheel',
  (e) => {
    if (settingsModal.open || Math.abs(e.deltaY) < 20) return;
    const now = Date.now();
    if (now < wheelLockUntil) return;
    wheelLockUntil = now + 500;
    if (e.deltaY > 0) next();
    else prev();
  },
  { passive: true }
);

settingsBtn.addEventListener('click', () => {
  cookieInput.value = settings.cookie;
  imageSecondsInput.value = settings.imageSeconds;
  startMutedInput.checked = settings.startMuted;
  fillScreenInput.checked = settings.fillScreen;
  verticalInput.checked = settings.vertical;
  showImagesInput.checked = settings.showImages;
  showVideosInput.checked = settings.showVideos;
  showTextInput.checked = settings.showText;
  settingsModal.showModal();
});

settingsForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const filtersChanged =
    settings.showImages !== showImagesInput.checked ||
    settings.showVideos !== showVideosInput.checked ||
    settings.showText !== showTextInput.checked;

  settings.cookie = cookieInput.value.trim();
  settings.imageSeconds = Math.max(1, parseFloat(imageSecondsInput.value) || DEFAULTS.imageSeconds);
  settings.startMuted = startMutedInput.checked;
  settings.fillScreen = fillScreenInput.checked;
  settings.vertical = verticalInput.checked;
  settings.showImages = showImagesInput.checked;
  settings.showVideos = showVideosInput.checked;
  settings.showText = showTextInput.checked;
  saveSettings();
  applyFill();
  applyDirection();

  if (!settings.showImages && !settings.showVideos && !settings.showText) {
    showToast('All post types disabled — the feed will be empty');
  } else {
    showToast('Settings saved');
  }
  // The loaded feed was filtered with the old toggles; reload it.
  if (filtersChanged && feedActive) startFeed(feedPath);
});

document.addEventListener('keydown', (e) => {
  if (settingsModal.open || document.activeElement === feedInput) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePause();
      break;
    case 'ArrowRight':
    case 'ArrowDown':
    case 'j':
      if (e.key === 'ArrowDown') e.preventDefault();
      next();
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'k':
      if (e.key === 'ArrowUp') e.preventDefault();
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
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

applyFill();
applyDirection();
updateMuteBtn();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
