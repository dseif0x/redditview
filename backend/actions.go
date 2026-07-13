package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// Write actions (vote/save) against reddit's cookie-authenticated API need a
// modhash — reddit's CSRF token — sent as the `uh` form field. It comes from
// /api/me.json (along with the username, used to resolve the "saved" feed)
// and is cached per cookie, refreshed once on rejection.

type identity struct {
	Modhash string
	Name    string
}

var identities = struct {
	sync.Mutex
	m map[string]identity
}{m: map[string]identity{}}

func cookieKey(cookie string) string {
	sum := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(sum[:])
}

func getIdentity(r *http.Request, cookie string, force bool) (identity, error) {
	key := cookieKey(cookie)
	identities.Lock()
	cached, ok := identities.m[key]
	identities.Unlock()
	if ok && !force {
		return cached, nil
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://old.reddit.com/api/me.json", nil)
	if err != nil {
		return identity{}, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Cookie", cookie)

	resp, err := httpClient.Do(req)
	if err != nil {
		return identity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return identity{}, fmt.Errorf("reddit /api/me returned %d", resp.StatusCode)
	}

	var body struct {
		Data struct {
			Modhash string `json:"modhash"`
			Name    string `json:"name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return identity{}, fmt.Errorf("failed to parse /api/me: %w", err)
	}
	if body.Data.Modhash == "" || body.Data.Name == "" {
		return identity{}, fmt.Errorf("cookie is not logged in (reddit did not identify the session)")
	}

	id := identity{Modhash: body.Data.Modhash, Name: body.Data.Name}
	identities.Lock()
	identities.m[key] = id
	identities.Unlock()
	return id, nil
}

var fullnameRe = regexp.MustCompile(`^t3_[a-z0-9]+$`)

func handleVote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID  string `json:"id"`
		Dir int    `json:"dir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return
	}
	if !fullnameRe.MatchString(in.ID) || in.Dir < -1 || in.Dir > 1 {
		http.Error(w, "invalid id or dir", http.StatusBadRequest)
		return
	}
	form := url.Values{"id": {in.ID}, "dir": {fmt.Sprint(in.Dir)}}
	doRedditAction(w, r, "https://old.reddit.com/api/vote", form)
}

func handleSave(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID   string `json:"id"`
		Save bool   `json:"save"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return
	}
	if !fullnameRe.MatchString(in.ID) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	endpoint := "https://old.reddit.com/api/save"
	if !in.Save {
		endpoint = "https://old.reddit.com/api/unsave"
	}
	doRedditAction(w, r, endpoint, url.Values{"id": {in.ID}})
}

func doRedditAction(w http.ResponseWriter, r *http.Request, endpoint string, form url.Values) {
	cookie := r.Header.Get("X-Reddit-Cookie")
	if cookie == "" {
		http.Error(w, "reddit cookie required — set it in settings", http.StatusUnauthorized)
		return
	}

	for attempt := 0; ; attempt++ {
		ident, err := getIdentity(r, cookie, attempt > 0)
		if err != nil {
			http.Error(w, "could not get modhash: "+err.Error(), http.StatusBadGateway)
			return
		}
		form.Set("uh", ident.Modhash)

		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader(form.Encode()))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

		resp, err := httpClient.Do(req)
		if err != nil {
			http.Error(w, "reddit request failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		rejected := resp.StatusCode == http.StatusForbidden || strings.Contains(string(body), "USER_REQUIRED")
		if rejected && attempt == 0 {
			continue // stale modhash: refresh and retry once
		}
		if resp.StatusCode != http.StatusOK || rejected {
			http.Error(w, fmt.Sprintf("reddit returned %d: %.200s", resp.StatusCode, strings.TrimSpace(string(body))), http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
		return
	}
}
