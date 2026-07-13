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
   Network → any logged-in `reddit.com` request → copy the `Cookie` header)
   and set the image duration.
2. Enter a feed and press **Go**:
   - empty → your home feed (requires cookie)
   - `r/pics`, `r/pics/top?t=week`
   - `user/<name>/m/<multi>` (private multis require cookie)
   - `u/<name>/submitted`
   - or paste any full reddit URL

Controls: `←`/`→` or edge clicks to navigate, `space` to pause, `m` to toggle
sound.

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
