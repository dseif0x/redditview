package main

import (
	"bufio"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Hosts we are willing to proxy media from. Suffix-matched against the
// requested URL's hostname (exact match or any subdomain).
var allowedMediaHosts = []string{
	"redd.it",
	"redditmedia.com",
	"redditstatic.com",
	"imgur.com",
}

func mediaHostAllowed(host string) bool {
	host = strings.ToLower(host)
	for _, d := range allowedMediaHosts {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}

// handleMedia streams a whitelisted remote media URL to the client. This
// exists because reddit's CDNs don't reliably allow cross-origin access and
// some assets require reddit-ish request headers. HLS playlists are rewritten
// so every segment/variant URI also routes back through this proxy.
func handleMedia(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("u")
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "https" || !mediaHostAllowed(target.Hostname()) {
		http.Error(w, "invalid or disallowed media url", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://www.reddit.com/")
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		http.Error(w, "media request failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	isPlaylist := strings.Contains(ct, "mpegurl") || strings.HasSuffix(strings.ToLower(target.Path), ".m3u8")

	if isPlaylist && resp.StatusCode == http.StatusOK {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
		if err != nil {
			http.Error(w, "failed to read playlist", http.StatusBadGateway)
			return
		}
		rewritten := rewritePlaylist(string(body), target)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, rewritten)
		return
	}

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

var uriAttrRe = regexp.MustCompile(`URI="([^"]+)"`)

// rewritePlaylist points every URI in an m3u8 (segment lines and URI="..."
// tag attributes) back at /api/media, resolving relative references against
// the playlist's own URL.
func rewritePlaylist(body string, base *url.URL) string {
	proxied := func(ref string) string {
		abs, err := base.Parse(ref)
		if err != nil {
			return ref
		}
		return "/api/media?u=" + url.QueryEscape(abs.String())
	}

	var out strings.Builder
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 10<<20)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "#"):
			line = uriAttrRe.ReplaceAllStringFunc(line, func(m string) string {
				ref := uriAttrRe.FindStringSubmatch(m)[1]
				return `URI="` + proxied(ref) + `"`
			})
		case trimmed != "":
			line = proxied(trimmed)
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	return out.String()
}
