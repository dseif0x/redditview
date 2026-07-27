# redditview mobile (Expo spike)

A React Native / Expo proof-of-concept of the feed with a **native video
player** (expo-video = AVPlayer on iOS: native HLS, no autoplay policies) and
native paging, talking to the same Go backend as the web app.

## Try it on your iPhone (no Mac needed)

1. Install **Expo Go** from the App Store.
2. On any machine on the same network:

   ```sh
   cd mobile && npm install && npx expo start
   ```

3. Scan the QR code with the iPhone camera — the app opens in Expo Go.
4. On first launch the settings sheet opens automatically: set the **Server
   URL** of a deployed redditview instance and paste your **reddit cookie**
   (same cookie as the web app; optional for public subreddits). Both persist
   on the device and the cookie is sent per request as `X-Reddit-Cookie`.
5. Enter a feed (`r/pics`, `saved`, empty = home) and press Go.

`npx expo start --web` runs the same code in a browser (video falls back to
mp4 there — no hls.js glue in the spike).

## Web build / the `:rn` image

`npx expo export --platform web` produces a static web build of this same
app (react-native-web). `Dockerfile.rn` — built by
`.github/workflows/rn-preview.yml` as `ghcr.io/…/redditview:rn` — packages
it with the Go backend in place of the classic frontend. Served that way,
an empty server URL means same origin, so the deployed app needs no
configuration, and it stays installable as a PWA (manifest + service
worker are wired up by `src/pwa.web.ts` from `public/`).

## Spike scope

In: vertical paged feed, native video with audio (redgifs resolution
included), images, galleries (horizontal pager), text posts, upvote/
downvote/save (optimistic, reverted on failure), mute toggle, infinite
pagination, persisted settings.

Out (see `frontend/` for the full web feature set): comments, sort picker,
autoscroll, bookmarks, multi-account, seen-tracking, pinch zoom, seek bar,
settings export/import.
