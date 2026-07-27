<script>
  // One mounted slide of the window. The shell (position, transforms, taps)
  // is declarative; the video element itself is pooled and managed
  // imperatively because WebKit grants sound rights per element (see the
  // video pool in lib/player.svelte.js).
  import { onMount } from 'svelte';
  import {
    P,
    Hls,
    mediaUrl,
    registerController,
    isEntryActive,
    slideTap,
    timerTapToggle,
    takeVideo,
    releasePooledVideo,
    attemptPlay,
    resolveRedgifs,
    activateIfCurrent,
    skipFailedSlide,
    videoTimeUpdate,
    videoEnded,
  } from '../lib/player.svelte.js';
  import { settings } from '../lib/settings.svelte.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { alog } from '../lib/debug.svelte.js';

  let { entry } = $props();
  // A slide is keyed by uid: its position and post never change over its
  // lifetime, so capturing them once is intentional.
  // svelte-ignore state_referenced_locally
  const post = P.posts[entry.pos];

  let slideEl = $state(null);
  let videoBox = $state(null);
  let galleryEls = $state([]);

  let gidx = $state(0);
  let zooming = $state(false);
  let pauseVisible = $state(false);
  let posterGone = $state(false);
  let redgifsLoading = $state(
    post.kind === 'video' && !!(post.redgifsId && !post.redgifsMp4 && !post.redgifsResolved)
  );

  let video = null;
  let hls = null;
  let videoAC = null;
  let failed = false;
  let destroyed = false;

  const isActive = $derived(P.activeUid === entry.uid);
  const axis = $derived(settings.vertical ? 'Y' : 'X');
  const crossAxis = $derived(settings.vertical ? 'X' : 'Y');
  // Evicted slides sit off-screen through the transition and don't follow
  // drags, matching the old app's behavior of dropping them from the map.
  const dragPx = $derived(P.dragging && !entry.evicted ? P.dragPx : 0);
  const transform = $derived(
    entry.off === 0 && !dragPx ? '' : `translate${axis}(calc(${entry.off}% + ${dragPx}px))`
  );
  const sliding = $derived(entry.animate && !P.dragging);
  const gDragPx = $derived(P.galleryDragging && isActive ? P.galleryDragPx : 0);
  const stripTransform = $derived(
    gidx === 0 && !gDragPx ? '' : `translate${crossAxis}(calc(${-gidx * 100}% + ${gDragPx}px))`
  );
  const stripSliding = $derived(settings.smoothScroll && !P.galleryDragging);

  function singleTap() {
    if (post.kind === 'video') {
      // A tap anywhere on the slide (not just the video itself) pauses/resumes.
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else {
      timerTapToggle();
    }
  }

  function imgFailed() {
    failed = true;
    if (isEntryActive(entry.uid)) {
      showToast('Image failed to load, skipping');
      skipFailedSlide(entry.uid, 800);
    }
  }

  function buildVideo() {
    // Sources in preference order; on failure fall through to the next.
    const sources = [];
    if (post.redgifsMp4) sources.push({ type: 'mp4', url: post.redgifsMp4 });
    if (post.videoHls) sources.push({ type: 'hls', url: post.videoHls });
    if (post.videoMp4) sources.push({ type: 'mp4', url: post.videoMp4, silent: !!post.videoHls });
    let si = -1;

    video = takeVideo(); // recycled elements keep their playback rights
    alog(`p${entry.pos}: video el ${video.__pooled ? 'reused' : 'new'}`);
    videoAC = new AbortController();
    const sig = { signal: videoAC.signal };
    video.playsInline = true;
    // Buffer while still off-screen — except the deferred-mounted previous
    // neighbor, which is the less likely destination.
    video.preload = entry.preloadHint === 'metadata' ? 'metadata' : 'auto';
    video.muted = true; // silent as preview; activation applies the real state
    video.loop = !settings.autoscroll;

    // The element's own poster is cleared the moment play() starts, leaving
    // a black gap until the first frame decodes. The overlay <img> in the
    // template only drops once frames are actually rendering.
    const dropPoster = () => (posterGone = true);
    video.addEventListener('playing', dropPoster, sig);
    video.addEventListener(
      'timeupdate',
      () => {
        if (video.currentTime > 0.05) dropPoster();
      },
      sig
    );

    const loadNextSource = (why) => {
      if (si >= 0) {
        console.warn('video source failed:', sources[si]?.url, why);
        alog(`p${entry.pos}: source fallback (${why})`);
      }
      si++;
      const s = sources[si];
      if (!s) {
        failed = true;
        if (isEntryActive(entry.uid)) {
          showToast(`Video failed (${why}), skipping`);
          skipFailedSlide(entry.uid, 800);
        }
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
        if (s.silent && isEntryActive(entry.uid)) showToast('Video stream failed — using fallback (no audio)');
        video.src = mediaUrl(s.url);
      }
      if (isEntryActive(entry.uid)) attemptPlay(video);
    };

    // With autoscroll on, videos run to the end, then advance (loop is off).
    video.addEventListener('ended', () => videoEnded(entry.uid), sig);
    video.addEventListener('error', () => loadNextSource('playback error'), sig);

    // A centered paused indicator so a stopped video is unmistakable. Only
    // the playing->paused edge shows it, so activation (paused until the
    // deferred play) never flashes it; deactivation hides it explicitly.
    video.addEventListener(
      'pause',
      () => {
        if (isEntryActive(entry.uid) && settings.showPauseIcon && !document.hidden && video.currentTime > 0) {
          pauseVisible = true;
        }
      },
      sig
    );
    video.addEventListener('play', () => (pauseVisible = false), sig);

    // Playback progress in the bottom bar (only while this slide is active).
    video.addEventListener('timeupdate', () => videoTimeUpdate(entry.uid, video), sig);

    videoBox.appendChild(video);
    loadNextSource('start');
  }

  onMount(() => {
    const unregister = registerController(entry.uid, {
      kind: post.kind,
      getVideo: () => video,
      isFailed: () => failed,
      deactivate() {
        if (video) {
          video.pause();
          video.muted = true; // previews never make sound
          alog(`deactivate p${entry.pos}: muted`);
        }
        pauseVisible = false;
      },
      galleryCount: () => (post.kind === 'gallery' ? post.images.length : 0),
      galleryIdx: () => gidx,
      galleryStep(dir) {
        const ni = gidx + dir;
        if (ni < 0 || ni >= post.images.length) return false;
        gidx = ni;
        return true;
      },
      media() {
        if (video) return { el: video, setZooming: (z) => (zooming = z) };
        const img = post.kind === 'gallery' ? galleryEls[gidx] : slideEl?.querySelector('img');
        return img ? { el: img, setZooming: (z) => (zooming = z) } : null;
      },
      // Commit the current layout so a transform set right after mounting
      // becomes the transition's start point (fresh slide-in animation).
      reflow() {
        if (slideEl) void slideEl.offsetWidth;
      },
    });

    if (post.kind === 'video') {
      if (redgifsLoading) {
        // Reddit's transcode of redgifs posts has no audio; resolve the real
        // (signed, expiring) redgifs mp4 first, then build the element.
        post.redgifsResolved = true;
        resolveRedgifs(post).then(() => {
          if (destroyed) return;
          redgifsLoading = false;
          buildVideo();
          activateIfCurrent(entry.uid);
        });
      } else {
        buildVideo();
      }
    }

    return () => {
      destroyed = true;
      unregister();
      hls?.destroy();
      hls = null;
      videoAC?.abort(); // drop this slide's listeners before pool reuse
      videoAC = null;
      releasePooledVideo(video);
      video = null;
    };
  });
</script>

<div
  bind:this={slideEl}
  class="slide"
  class:sliding
  class:zooming
  style:transform={transform}
  use:slideTap={{ uid: entry.uid, single: singleTap }}
>
  {#if post.kind === 'video'}
    {#if post.poster}
      <img
        class="poster-overlay"
        class:gone={posterGone}
        decoding="async"
        src={mediaUrl(post.poster)}
        alt=""
      />
    {/if}
    <div class="video-box" bind:this={videoBox}></div>
    {#if redgifsLoading}
      <div class="loading"><div class="spinner"></div></div>
    {/if}
    <div class="pause-indicator" hidden={!pauseVisible || !settings.showPauseIcon}></div>
  {:else if post.kind === 'gallery'}
    <!-- gallery: all images in one slide, stacked along the cross axis -->
    <div class="gallery-strip" class:sliding={stripSliding} style:transform={stripTransform}>
      {#each post.images as src, j (j)}
        <div class="gallery-cell">
          <img
            bind:this={galleryEls[j]}
            decoding="async"
            loading={j <= 1 ? 'eager' : 'lazy'}
            src={mediaUrl(src)}
            alt={post.title}
          />
        </div>
      {/each}
    </div>
  {:else if post.kind === 'text'}
    <div class="text-post">
      <h2>{post.title}</h2>
      {#if post.text}
        <p>{post.text.length > 2000 ? post.text.slice(0, 2000) + '…' : post.text}</p>
      {/if}
    </div>
  {:else}
    <img decoding="async" src={mediaUrl(post.images[0])} alt={post.title} onerror={imgFailed} />
  {/if}
</div>
