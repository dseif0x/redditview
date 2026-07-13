package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// Reddit does not host redgifs video itself — its reddit_video_preview
// transcode is always silent. To get audio we resolve the gif against the
// redgifs API, which needs a (free, anonymous) temporary bearer token.

var rgToken struct {
	sync.Mutex
	token string
}

func redgifsToken(r *http.Request, force bool) (string, error) {
	rgToken.Lock()
	defer rgToken.Unlock()
	if rgToken.token != "" && !force {
		return rgToken.token, nil
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.redgifs.com/v2/auth/temporary", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("redgifs auth returned %d", resp.StatusCode)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil || body.Token == "" {
		return "", fmt.Errorf("redgifs auth: no token in response")
	}
	rgToken.token = body.Token
	return rgToken.token, nil
}

var redgifsIDValid = regexp.MustCompile(`^[a-z0-9]+$`)

func handleRedgifs(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.URL.Query().Get("id"))
	if !redgifsIDValid.MatchString(id) {
		http.Error(w, "invalid redgifs id", http.StatusBadRequest)
		return
	}

	for attempt := 0; ; attempt++ {
		token, err := redgifsToken(r, attempt > 0)
		if err != nil {
			http.Error(w, "redgifs auth failed: "+err.Error(), http.StatusBadGateway)
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.redgifs.com/v2/gifs/"+id, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := httpClient.Do(req)
		if err != nil {
			http.Error(w, "redgifs request failed: "+err.Error(), http.StatusBadGateway)
			return
		}

		// Expired/invalid token: refresh once and retry.
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			resp.Body.Close()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			http.Error(w, fmt.Sprintf("redgifs returned %d", resp.StatusCode), http.StatusBadGateway)
			return
		}

		var body struct {
			Gif struct {
				HasAudio bool    `json:"hasAudio"`
				Duration float64 `json:"duration"`
				Urls     struct {
					HD     string `json:"hd"`
					SD     string `json:"sd"`
					Poster string `json:"poster"`
				} `json:"urls"`
			} `json:"gif"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
		resp.Body.Close()
		if err != nil {
			http.Error(w, "failed to parse redgifs response: "+err.Error(), http.StatusBadGateway)
			return
		}

		mp4 := body.Gif.Urls.HD
		if mp4 == "" {
			mp4 = body.Gif.Urls.SD
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store") // urls are signed + expiring
		json.NewEncoder(w).Encode(map[string]any{
			"mp4":      mp4,
			"poster":   body.Gif.Urls.Poster,
			"hasAudio": body.Gif.HasAudio,
			"duration": body.Gif.Duration,
		})
		return
	}
}

var redgifsPathRe = regexp.MustCompile(`^/(?:watch|ifr|i)/([A-Za-z0-9]+)`)

// redgifsID extracts the gif id from redgifs post URLs
// (redgifs.com/watch/<id>, v3.redgifs.com/watch/<id>, i.redgifs.com/i/<id>.jpg ...).
func redgifsID(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host != "redgifs.com" && !strings.HasSuffix(host, ".redgifs.com") {
		return ""
	}
	p := u.Path
	if i := strings.LastIndex(p, "."); i > strings.LastIndex(p, "/") {
		p = p[:i] // strip extension on direct media links
	}
	if m := redgifsPathRe.FindStringSubmatch(p); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}
