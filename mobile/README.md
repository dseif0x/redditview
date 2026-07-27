# redditview mobile (React Native / Expo)

A fully native frontend for redditview with feature parity with the web app
(`frontend/`), talking to the same Go backend. Video is expo-video — AVPlayer
on iOS: native HLS through the media proxy, sound without any autoplay
gymnastics — and the feed is a native paging list.

## Features

Vertical (TikTok-style) or horizontal paged feed · native video with audio
(redgifs resolution included) · images · galleries (paging along the cross
axis, per-image counter) · text posts · autoscroll (images/galleries by
duration, videos advance when they end; tap pauses the countdown) ·
progress/seek bar dockable to any screen edge (drag to seek video) ·
upvote/downvote/save with optimistic revert · double-tap to upvote (burst
animation) · comments sheet (full tree, collapse subtrees, badges, sortable)
· sort picker (two native action sheets, per-feed path rewriting) · feed
bookmarks with sort · subreddit/author links jump into that feed, with a
back button restoring the exact position · resume last session at the exact
post · skip-seen tracking (capped, persisted) · post type filters ·
multi-account cookie management (masked until revealed) · settings
export/import (clipboard JSON, compatible schema) · fill-screen mode ·
pinch-to-zoom (transient, springs back) · persisted mute.

Also ported: the bottom tab bar (Posts / Settings, with the settings page
over the feed like the web frontend) and desktop keyboard shortcuts on web
(space, arrows, j/k, m, f, a/z, s, c, Esc).

Not ported (web-platform workarounds with no native equivalent): the
smooth-scroll toggle (native paging is always smooth), the debug overlay,
and edge-tap bar docking (the bar position is a settings picker instead).

## Deferred — worth implementing later

- **Web audio unlock** (matters only for the web/PWA build served by the
  `:rn` image): browsers still enforce autoplay-with-sound policies there.
  The classic frontend (`frontend/src/main.js`) has the full playbook:
  fall back to muted playback when `play()` rejects with `NotAllowedError`,
  re-lift the mute on the next user gesture (touchend/click capture
  listener), and — the part that needs raw element access — a recycled pool
  of gesture-"blessed" `<video>` elements so gestureless starts (autoscroll
  advances) keep sound on iOS Safari. The fallback + gesture-rescue halves
  are implementable web-only against `expo-video`'s player API; the pool
  would need patching expo-video's web VideoView or a custom web player.
  Until then: the web build plays videos muted reliably; unmuted playback
  may pause on advance in iOS Safari until tapped.
- **Browser history integration** (web/PWA): the classic frontend pushes a
  history entry per feed change with cursor+post state, so browser
  back/forward (and iOS edge swipes) restore the exact position. The RN
  app has the same state in its in-app history stack (`history` in
  App.tsx) — wiring it to `history.pushState`/`popstate` in a web-only
  module would restore parity.

## Try it on your iPhone (no Mac needed)

1. Install **Expo Go** from the App Store.
2. On any machine on the same network:

   ```sh
   cd mobile && npm install && npx expo start
   ```

3. Scan the QR code with the iPhone camera — the app opens in Expo Go.
4. On first launch the settings sheet opens: set the **Server URL** of a
   deployed redditview instance and paste your **reddit cookie** (same
   cookie as the web app; optional for public subreddits). Both persist on
   the device; the cookie is sent per request as `X-Reddit-Cookie`.

Or sideload the unsigned `.ipa` built by `.github/workflows/rn-preview.yml`
on every push to the spike branch.

## Web build / the `:rn` image

`npx expo export --platform web` produces a static web build of this same
app (react-native-web). `Dockerfile.rn` — built by the same workflow as
`ghcr.io/…/redditview:rn` — packages it with the Go backend in place of the
classic frontend. Served that way, an empty server URL means same origin, so
the deployed app needs no configuration, and it stays installable as a PWA
(manifest + service worker are wired up by `src/pwa.web.ts` from `public/`).
Web caveat: video uses the mp4 fallback in non-Safari browsers (no hls.js
glue).
