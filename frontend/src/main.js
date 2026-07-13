import Hls from 'hls.js';
import './style.css';

// ---------------------------------------------------------------------------
// Settings (localStorage only)
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'redditview.settings';
const DEFAULTS = {
  cookie: '',
  accounts: [],
  activeAccount: 0,
  imageSeconds: 8,
  startMuted: false,
  autoscroll: false,
  lastFeed: '',
  showImages: true,
  showVideos: true,
  showText: true,
  fillScreen: false,
  vertical: false,
  smoothScroll: true,
};

let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
} catch {
  /* corrupted storage -> defaults */
}

// Migrate a pre-accounts cookie into the account list.
if (!Array.isArray(settings.accounts)) settings.accounts = [];
if (settings.accounts.length === 0 && settings.cookie) {
  settings.accounts = [{ name: 'Account 1', cookie: settings.cookie }];
  settings.activeAccount = 0;
}

function activeCookie() {
  const a = settings.accounts[settings.activeAccount];
  return a ? a.cookie.trim() : '';
}
settings.cookie = activeCookie();

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
let muted = settings.startMuted;

let timerId = null;
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
const accountSelect = $('#account-select');
const accountNameInput = $('#account-name-input');
const deleteAccountBtn = $('#delete-account-btn');
const showImagesInput = $('#show-images-input');
const showVideosInput = $('#show-videos-input');
const showTextInput = $('#show-text-input');
const fillScreenInput = $('#fill-screen-input');
const verticalInput = $('#vertical-input');
const smoothScrollInput = $('#smooth-scroll-input');
const fillBtn = $('#fill-btn');
const appEl = $('#app');
const prevZone = $('#prev-zone');
const nextZone = $('#next-zone');
const progressEl = $('#progress');
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
// Autoscroll timer (images / galleries / text) with progress bar. Only runs
// when autoscroll is enabled; otherwise slides stay until manually advanced.
// ---------------------------------------------------------------------------
function startTimer(seconds) {
  clearTimer();
  if (!settings.autoscroll) return;
  timerRemainingMs = seconds * 1000;
  progressFill.style.transition = 'none';
  progressFill.style.width = '0%';
  // Force reflow so the width reset applies before the transition starts.
  void progressFill.offsetWidth;
  timerId = setTimeout(onTimerDone, timerRemainingMs);
  progressFill.style.transition = `width ${timerRemainingMs}ms linear`;
  progressFill.style.width = '100%';
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
  next(); // steps through gallery images before advancing to the next post
}

// ---------------------------------------------------------------------------
// Slide rendering
// ---------------------------------------------------------------------------
function stopSlide() {
  clearTimer();
  progressEl.classList.remove('seekable');
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
  // Step through gallery images before leaving the post.
  const current = posts[idx];
  if (current?.kind === 'gallery' && galleryIdx < current.images.length - 1) {
    galleryIdx++;
    renderSlide(1);
    return;
  }
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
  renderSlide(1);
  maybePrefetch();
}

function prev() {
  const current = posts[idx];
  if (current?.kind === 'gallery' && galleryIdx > 0) {
    galleryIdx--;
    renderSlide(-1);
    return;
  }
  if (idx <= 0) return;
  idx--;
  galleryIdx = 0;
  renderSlide(-1);
}

const SLIDE_MS = 350;

// dir: 1 = advancing (new slide enters from the far side), -1 = going back,
// 0 = replace without animation.
function renderSlide(dir = 0) {
  const post = posts[idx];
  if (!post) return;

  // Cut short any transition still in flight.
  viewer.querySelectorAll('.slide.exiting').forEach((el) => el.remove());
  const oldSlide = viewer.querySelector('.slide');

  // Take over the outgoing slide's media so it keeps its last frame while it
  // animates out; actual teardown happens after the transition.
  const oldHls = hls;
  const oldVideo = currentVideo;
  hls = null;
  currentVideo = null;
  clearTimer();
  progressEl.classList.remove('seekable');
  oldVideo?.pause();

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

  const retire = () => {
    oldHls?.destroy();
    oldVideo?.removeAttribute('src');
  };

  if (settings.smoothScroll && dir !== 0 && oldSlide) {
    const axis = settings.vertical ? 'Y' : 'X';
    slide.style.transform = `translate${axis}(${dir > 0 ? 100 : -100}%)`;
    viewer.appendChild(slide);
    void slide.offsetWidth; // commit the start position before transitioning
    slide.classList.add('sliding');
    oldSlide.classList.add('sliding', 'exiting');
    oldSlide.style.transition = '';
    slide.style.transform = '';
    oldSlide.style.transform = `translate${axis}(${dir > 0 ? -100 : 100}%)`;
    setTimeout(() => {
      retire();
      oldSlide.remove();
      slide.classList.remove('sliding');
    }, SLIDE_MS + 50);
  } else {
    retire();
    viewer.innerHTML = '';
    viewer.appendChild(slide);
  }

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
  // Without autoscroll, videos loop instead of advancing the feed.
  video.loop = !settings.autoscroll;
  if (post.poster) video.poster = mediaUrl(post.poster);

  const attemptPlay = () => {
    // Autoplay with sound is often blocked before user interaction: fall back
    // to muted playback rather than stalling the feed (unmute with 🔇 / m).
    video.play().catch(() => {
      if (!video.muted) {
        video.muted = true;
        updateMuteBtn();
        video.play().catch(() => {});
      }
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

  // With autoscroll on, videos run to the end, then advance (loop is off).
  video.addEventListener('ended', () => {
    if (settings.autoscroll) next();
  });
  video.addEventListener('error', () => loadNextSource('playback error'));
  // A tap anywhere on the slide (not just the video itself) pauses/resumes.
  slide.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });

  // Playback progress in the bottom bar, with seeking.
  progressEl.classList.add('seekable');
  video.addEventListener('timeupdate', () => {
    if (!video.duration || scrubbing) return;
    progressFill.style.transition = 'none';
    progressFill.style.width = (video.currentTime / video.duration) * 100 + '%';
  });

  currentVideo = video;
  slide.appendChild(video);
  loadNextSource('start');
}

// Seek by clicking/dragging the progress bar while a video plays.
let scrubbing = false;
function seekFromPointer(e) {
  if (!currentVideo || !currentVideo.duration) return;
  const rect = progressEl.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  currentVideo.currentTime = frac * currentVideo.duration;
  progressFill.style.transition = 'none';
  progressFill.style.width = frac * 100 + '%';
}
progressEl.addEventListener('pointerdown', (e) => {
  if (!progressEl.classList.contains('seekable')) return;
  scrubbing = true;
  progressEl.setPointerCapture(e.pointerId);
  seekFromPointer(e);
});
progressEl.addEventListener('pointermove', (e) => {
  if (scrubbing) seekFromPointer(e);
});
progressEl.addEventListener('pointerup', () => {
  scrubbing = false;
});
progressEl.addEventListener('pointercancel', () => {
  scrubbing = false;
});


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
// Autoscroll / mute
// ---------------------------------------------------------------------------
function updateAutoscrollBtn() {
  pauseBtn.textContent = settings.autoscroll ? '⏸' : '▶';
  pauseBtn.classList.toggle('active', settings.autoscroll);
  pauseBtn.title = settings.autoscroll ? 'Autoscroll on — click to stop (space)' : 'Autoscroll off — click to start (space)';
}

function toggleAutoscroll() {
  settings.autoscroll = !settings.autoscroll;
  saveSettings();
  updateAutoscrollBtn();
  if (currentVideo) currentVideo.loop = !settings.autoscroll;
  const post = posts[idx];
  if (settings.autoscroll) {
    if (post && post.kind !== 'video') startTimer(settings.imageSeconds);
    showToast('Autoscroll on', 1200);
  } else {
    if (post && post.kind !== 'video') clearTimer();
    showToast('Autoscroll off', 1200);
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

pauseBtn.addEventListener('click', toggleAutoscroll);
$('#saved-btn').addEventListener('click', () => {
  if (!activeCookie()) {
    showToast('Set your reddit cookie in ⚙ settings to browse saved posts');
    return;
  }
  feedInput.value = 'saved';
  startFeed('saved');
});
muteBtn.addEventListener('click', toggleMute);
fillBtn.addEventListener('click', toggleFill);
nextZone.addEventListener('click', next);
prevZone.addEventListener('click', prev);
upBtn.addEventListener('click', () => vote(1));
downBtn.addEventListener('click', () => vote(-1));
saveBtn.addEventListener('click', toggleSave);

// Swipe gestures: swipe toward the next slide along the configured axis.
// With smooth scrolling the slide follows the finger and snaps back when the
// swipe doesn't reach the threshold.
let touchStartX = 0;
let touchStartY = 0;
let dragSlide = null;
let dragging = false;
viewer.addEventListener(
  'touchstart',
  (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    dragging = false;
    dragSlide =
      settings.smoothScroll && !e.target.closest('.text-post')
        ? viewer.querySelector('.slide:not(.exiting)')
        : null;
  },
  { passive: true }
);
viewer.addEventListener(
  'touchmove',
  (e) => {
    if (!dragSlide || !dragSlide.isConnected) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    const main = settings.vertical ? dy : dx;
    const cross = settings.vertical ? dx : dy;
    if (!dragging && Math.abs(main) > 10 && Math.abs(main) > Math.abs(cross)) dragging = true;
    if (dragging) {
      dragSlide.style.transition = 'none';
      dragSlide.style.transform = `translate${settings.vertical ? 'Y' : 'X'}(${main}px)`;
    }
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
    const fired = Math.abs(main) >= 60 && Math.abs(main) >= Math.abs(cross) * 1.5;

    if (dragging && dragSlide?.isConnected) {
      dragSlide.style.transition = '';
      if (!fired) {
        // Snap back to center.
        dragSlide.classList.add('sliding');
        dragSlide.style.transform = '';
        const el = dragSlide;
        setTimeout(() => el.classList.remove('sliding'), SLIDE_MS + 50);
      }
    }
    dragSlide = null;
    if (!fired) return;
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

// Which account the modal is editing: an index into settings.accounts, or -1
// for the "add new account" entry.
let editingAccount = 0;

function populateAccountSelect() {
  accountSelect.innerHTML = '';
  settings.accounts.forEach((a, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = (a.name || `Account ${i + 1}`) + (i === settings.activeAccount ? ' (active)' : '');
    accountSelect.appendChild(opt);
  });
  const add = document.createElement('option');
  add.value = 'new';
  add.textContent = '+ Add account…';
  accountSelect.appendChild(add);
  accountSelect.value = editingAccount === -1 ? 'new' : String(editingAccount);
}

function loadAccountFields() {
  const a = settings.accounts[editingAccount];
  accountNameInput.value = a ? a.name : '';
  cookieInput.value = a ? a.cookie : '';
  deleteAccountBtn.hidden = !a;
}

accountSelect.addEventListener('change', () => {
  editingAccount = accountSelect.value === 'new' ? -1 : Number(accountSelect.value);
  loadAccountFields();
});

deleteAccountBtn.addEventListener('click', () => {
  if (editingAccount < 0) return;
  settings.accounts.splice(editingAccount, 1);
  if (settings.activeAccount >= settings.accounts.length) settings.activeAccount = 0;
  editingAccount = settings.accounts.length ? Math.min(editingAccount, settings.accounts.length - 1) : -1;
  const prevCookie = settings.cookie;
  settings.cookie = activeCookie();
  saveSettings();
  populateAccountSelect();
  loadAccountFields();
  showToast('Account deleted');
  if (prevCookie !== settings.cookie && feedActive) startFeed(feedPath);
});

settingsBtn.addEventListener('click', () => {
  editingAccount = settings.accounts.length ? settings.activeAccount : -1;
  populateAccountSelect();
  loadAccountFields();
  imageSecondsInput.value = settings.imageSeconds;
  startMutedInput.checked = settings.startMuted;
  fillScreenInput.checked = settings.fillScreen;
  verticalInput.checked = settings.vertical;
  smoothScrollInput.checked = settings.smoothScroll;
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
  const prevCookie = settings.cookie;

  // Saving selects the edited account as the active one.
  const name = accountNameInput.value.trim();
  const cookie = cookieInput.value.trim();
  if (editingAccount === -1) {
    if (name || cookie) {
      settings.accounts.push({ name: name || `Account ${settings.accounts.length + 1}`, cookie });
      settings.activeAccount = settings.accounts.length - 1;
    }
  } else if (settings.accounts[editingAccount]) {
    settings.accounts[editingAccount] = { name: name || `Account ${editingAccount + 1}`, cookie };
    settings.activeAccount = editingAccount;
  }
  settings.cookie = activeCookie();

  settings.imageSeconds = Math.max(1, parseFloat(imageSecondsInput.value) || DEFAULTS.imageSeconds);
  settings.startMuted = startMutedInput.checked;
  settings.fillScreen = fillScreenInput.checked;
  settings.vertical = verticalInput.checked;
  settings.smoothScroll = smoothScrollInput.checked;
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
  // Reload if the account or the type filters changed what the feed contains.
  if ((filtersChanged || prevCookie !== settings.cookie) && feedActive) startFeed(feedPath);
});

document.addEventListener('keydown', (e) => {
  if (settingsModal.open || document.activeElement === feedInput) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      toggleAutoscroll();
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
updateAutoscrollBtn();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
