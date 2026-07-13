# redditview

An autoscrolling media viewer for any reddit feed — home, subreddits,
public/private multireddits, user pages. Videos play to the end before
advancing; images advance after a configurable duration.

## How it works

- **backend/** — Go server. Proxies reddit's JSON listing API (forwarding your
  reddit cookie from a request header, never storing it) and proxies media from
  reddit/imgur CDNs, rewriting HLS playlists so reddit-hosted video plays with
  audio. Also serves the built frontend.
- **frontend/** — Vite + vanilla JS + hls.js. Fullscreen autoscroll feed with
  keyboard navigation. Cookie and settings live in `localStorage` only.

## Usage

1. Open the app and click **⚙** to paste your reddit cookie (DevTools →
   Network → any logged-in `reddit.com` request → copy the **entire** `Cookie`
   header — just `reddit_session` alone is usually rejected as a bot) and set
   the image duration.

   If reddit still returns 403: the backend already prefers `old.reddit.com`
   (less aggressive anti-bot filtering), but reddit blocks most
   datacenter/VPS IPs regardless of cookie — run the container somewhere with
   a residential IP. `REDDIT_USER_AGENT` overrides the User-Agent the backend
   sends; matching your own browser's UA (the one the cookie came from) helps.
2. Enter a feed and press **Go**:
   - empty → your home feed (requires cookie)
   - `r/pics`, `r/pics/top?t=week`
   - `user/<name>/m/<multi>` (private multis require cookie)
   - `u/<name>/submitted`
   - `saved` (or the ★ button), `upvoted`, `downvoted`, `hidden` → your own
     listings (require cookie; the backend resolves your username
     automatically)
   - or paste any full reddit URL

Controls: arrow keys, edge clicks, swipe, or mouse wheel to navigate; `space`
toggles autoscroll, `m` toggles sound, `f` toggles fill-screen, `a`/`z`/`s`
vote/save. Settings has a vertical navigation mode (swipe up/down,
TikTok-style) and multiple accounts (each with its own cookie).

Navigation uses smooth reels-style slide transitions by default (slides
follow your finger on touch and snap); disable in settings for instant
jumps. The previous and next posts stay mounted and preloaded — videos
buffer off-screen before you reach them and the real neighbor peeks in
while you swipe.

Autoscroll is off by default: videos loop and slides stay until you navigate.
Turning it on (▶ button or `space`) advances images after the configured
duration and videos when they end. The bottom bar shows video playback
progress and can be clicked/dragged to seek; tapping a video pauses it.

The app is an installable PWA (requires HTTPS): "Add to Home Screen" on
mobile or the install prompt in desktop browsers gives a standalone
fullscreen window. Feeds and media are never cached offline — only the app
shell is.

## Development

```sh
# backend (port 8080)
cd backend && go run .

# frontend (port 5173, proxies /api to the backend)
cd frontend && npm install && npm run dev
```

## Docker

The top-level `Dockerfile` builds both parts into a single image; the GitHub
Actions workflow (`.github/workflows/docker.yml`) publishes it to GHCR on
pushes to `main`.

```sh
docker build -t redditview .
docker run -p 8080:8080 redditview
```

## Kubernetes (Helm)

The chart in `charts/redditview` is published to GitHub Pages by
`.github/workflows/release-chart.yml` whenever `charts/**` changes on `main`
(bump `version` in `Chart.yaml` to cut a new release — chart-releaser skips
already-released versions). GitHub Pages must be set to serve the `gh-pages`
branch (Settings → Pages); the workflow creates the branch on first run.

```sh
helm repo add redditview https://dseif0x.github.io/redditview
helm install redditview redditview/redditview \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=redditview.example.com' \
  --set 'ingress.hosts[0].paths[0].path=/' \
  --set 'ingress.hosts[0].paths[0].pathType=Prefix' \
  --set 'ingress.tls[0].secretName=redditview-tls' \
  --set 'ingress.tls[0].hosts[0]=redditview.example.com'
```

Or with a values file:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: redditview.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: redditview-tls
      hosts:
        - redditview.example.com
env:
  REDDIT_USER_AGENT: 'Mozilla/5.0 ...'
```
