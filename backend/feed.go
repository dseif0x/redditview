package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Post is the normalized shape the frontend consumes.
type Post struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"` // fullname (t3_...), needed for vote/save
	Likes       *bool    `json:"likes"`
	Saved       bool     `json:"saved"`
	Title       string   `json:"title"`
	Author      string   `json:"author"`
	Subreddit   string   `json:"subreddit"`
	Permalink   string   `json:"permalink"`
	NSFW        bool     `json:"nsfw"`
	Score       int      `json:"score"`
	NumComments int      `json:"numComments"`
	Kind        string   `json:"kind"` // image | gallery | video | text
	Images      []string `json:"images,omitempty"`
	VideoHLS    string   `json:"videoHls,omitempty"`
	VideoMP4    string   `json:"videoMp4,omitempty"`
	RedgifsID   string   `json:"redgifsId,omitempty"`
	Poster      string   `json:"poster,omitempty"`
	Duration    float64  `json:"duration,omitempty"`
	Text        string   `json:"text,omitempty"`
	// Reddit's rendered selftext (media posts can carry body text too);
	// the client sanitizes and shows it as the caption under the title.
	BodyHTML string `json:"bodyHtml,omitempty"`
	LinkURL  string `json:"linkUrl,omitempty"`
}

type feedResponse struct {
	After string `json:"after"`
	Posts []Post `json:"posts"`
	// Which upstream served this page ("old" or "www"): the two hosts can
	// compose listings differently (www injects recommendations/promotions
	// old never shows), so the client keeps this for diagnostics.
	Host string `json:"host,omitempty"`
	// The reddit account the page's cookie authenticated as (resolved via
	// the cached /api/me identity). The client pins a feed to its first
	// page's user and refuses pages served for anyone else — the definitive
	// guard against another account's posts splicing in, wherever the
	// identity mixup happens.
	User string `json:"user,omitempty"`
}

// pageUser resolves which account a cookie authenticates as, for the feed
// response's provenance field. Best-effort: an unresolvable identity (rate
// limit, anonymous cookie) must not take the feed down.
func pageUser(r *http.Request, cookie string) string {
	if cookie == "" {
		return ""
	}
	ident, err := getIdentity(r, cookie, false)
	if err != nil {
		return ""
	}
	return ident.Name
}

// --- reddit JSON wire types (only the fields we need) ---

type listing struct {
	Data struct {
		After    string `json:"after"`
		Children []struct {
			Kind string   `json:"kind"`
			Data postData `json:"data"`
		} `json:"children"`
	} `json:"data"`
}

type redditVideo struct {
	HLSURL      string  `json:"hls_url"`
	FallbackURL string  `json:"fallback_url"`
	Duration    float64 `json:"duration"`
}

type mediaWrap struct {
	RedditVideo *redditVideo `json:"reddit_video"`
}

type mediaMeta struct {
	Status string `json:"status"`
	Type   string `json:"e"`
	Source struct {
		URL string `json:"u"`
		GIF string `json:"gif"`
		MP4 string `json:"mp4"`
	} `json:"s"`
}

type postData struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Likes         *bool  `json:"likes"`
	Saved         bool   `json:"saved"`
	Title         string `json:"title"`
	Author        string `json:"author"`
	Subreddit     string `json:"subreddit_name_prefixed"`
	Permalink     string `json:"permalink"`
	Over18        bool   `json:"over_18"`
	Score         int    `json:"score"`
	NumComments   int    `json:"num_comments"`
	Stickied      bool   `json:"stickied"`
	Promoted      bool   `json:"promoted"` // ads (www listings can carry them)
	IsGallery     bool   `json:"is_gallery"`
	IsSelf        bool   `json:"is_self"`
	PostHint      string `json:"post_hint"`
	URL           string `json:"url"`
	URLOverridden string `json:"url_overridden_by_dest"`
	Selftext      string `json:"selftext"`
	SelftextHTML  string `json:"selftext_html"`

	MediaMetadata map[string]mediaMeta `json:"media_metadata"`
	GalleryData   *struct {
		Items []struct {
			MediaID string `json:"media_id"`
		} `json:"items"`
	} `json:"gallery_data"`

	SecureMedia *mediaWrap `json:"secure_media"`
	Media       *mediaWrap `json:"media"`

	Preview *struct {
		Images []struct {
			Source struct {
				URL string `json:"url"`
			} `json:"source"`
		} `json:"images"`
		RedditVideoPreview *redditVideo `json:"reddit_video_preview"`
	} `json:"preview"`

	CrosspostParentList []postData `json:"crosspost_parent_list"`
}

// normalizeFeedPath turns whatever the user typed (full URL, "/r/pics/",
// "user/x/m/multi", "" for home) into a clean reddit path plus any query
// params it carried (e.g. r/pics/top?t=week).
func normalizeFeedPath(raw string) (path string, query url.Values, err error) {
	raw = strings.TrimSpace(raw)
	if i := strings.Index(raw, "://"); i >= 0 {
		raw = raw[i+3:]
		if j := strings.Index(raw, "/"); j >= 0 {
			raw = raw[j+1:]
		} else {
			raw = ""
		}
	}
	query = url.Values{}
	if i := strings.Index(raw, "?"); i >= 0 {
		query, err = url.ParseQuery(raw[i+1:])
		if err != nil {
			return "", nil, fmt.Errorf("bad feed query: %w", err)
		}
		raw = raw[:i]
	}
	raw = strings.Trim(raw, "/")
	raw = strings.TrimSuffix(raw, ".json")
	raw = strings.Trim(raw, "/")
	for _, seg := range strings.Split(raw, "/") {
		if seg == ".." {
			return "", nil, fmt.Errorf("invalid feed path")
		}
	}
	return raw, query, nil
}

// feedHosts are tried in order. old.reddit.com serves the same JSON listings
// but its anti-bot filtering is far less aggressive than www.reddit.com's.
var feedHosts = []string{"https://old.reddit.com/", "https://www.reddit.com/"}

// sanitizeCookie strips reddit's OAuth token cookies (token_v2 and its older
// sibling) from a pasted browser Cookie header before it is forwarded
// upstream. The two feed hosts resolve identity from DIFFERENT cookies:
// old.reddit.com authenticates with reddit_session, while www.reddit.com
// prefers a token_v2 JWT when one is present. A pasted header snapshots
// whichever token_v2 the browser held at copy time — with multiple accounts
// captured from the same browser that is routinely a token minted for a
// different account than the header's reddit_session — so a request that
// falls back from old to www would silently serve the OTHER account's
// listing into the middle of this account's feed. Dropping the tokens makes
// every host authenticate from reddit_session alone. Headers without a
// reddit_session are left untouched: there the token is the only identity,
// and removing it would anonymize the request instead.
func sanitizeCookie(header string) string {
	parts := strings.Split(header, ";")
	name := func(part string) string {
		if i := strings.Index(part, "="); i >= 0 {
			part = part[:i]
		}
		return strings.ToLower(strings.TrimSpace(part))
	}
	hasSession := false
	for _, part := range parts {
		if name(part) == "reddit_session" {
			hasSession = true
		}
	}
	if !hasSession {
		return header
	}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		switch name(part) {
		case "token_v2", "token":
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, ";")
}

// clientCookie extracts the sanitized reddit cookie from an API request.
func clientCookie(r *http.Request) string {
	return sanitizeCookie(r.Header.Get("X-Reddit-Cookie"))
}

func handleFeed(w http.ResponseWriter, r *http.Request) {
	path, extra, err := normalizeFeedPath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// The mixed always-something-new feed has its own multi-listing fetcher.
	if path == "fresh" {
		handleFresh(w, r)
		return
	}

	// Pseudo-feeds for the logged-in user's own listings; reddit only serves
	// these under the username, which we resolve from the cookie.
	switch path {
	case "saved", "upvoted", "downvoted", "hidden":
		cookie := clientCookie(r)
		if cookie == "" {
			http.Error(w, "reddit cookie required to view "+path+" posts — set it in settings", http.StatusUnauthorized)
			return
		}
		ident, err := getIdentity(r, cookie, false)
		if err != nil {
			http.Error(w, "could not resolve your username: "+err.Error(), http.StatusBadGateway)
			return
		}
		path = "user/" + ident.Name + "/" + path
	}

	q := url.Values{}
	for k, vs := range extra {
		q[k] = vs
	}
	q.Set("raw_json", "1")
	q.Set("limit", "25")
	if after := r.URL.Query().Get("after"); after != "" {
		q.Set("after", after)
	}

	var resp *http.Response
	lastStatus := 0
	lastBody := ""
	servedHost := ""
	for _, host := range feedHosts {
		target := host
		if path != "" {
			target += path + "/"
		}
		target += ".json?" + q.Encode()

		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		if cookie := clientCookie(r); cookie != "" {
			req.Header.Set("Cookie", cookie)
		}

		resp, err = httpClient.Do(req)
		if err != nil {
			http.Error(w, "reddit request failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		if resp.StatusCode == http.StatusOK {
			if strings.HasPrefix(host, "https://old.") {
				servedHost = "old"
			} else {
				servedHost = "www"
			}
			break
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		lastStatus = resp.StatusCode
		lastBody = strings.TrimSpace(string(body))
		resp = nil
	}

	if resp == nil {
		msg := fmt.Sprintf("reddit returned %d", lastStatus)
		if strings.Contains(lastBody, "<") || lastBody == "" {
			// reddit's block page is HTML; don't dump it at the user.
			msg += " (request blocked by reddit). Tips: paste your browser's FULL Cookie header in settings, not just reddit_session — reddit fingerprints requests and partial cookies look like bots. Reddit also blocks many datacenter/VPS IPs; if this server runs in a cloud, try it from a residential connection."
		} else {
			msg += ": " + lastBody
		}
		http.Error(w, msg, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var l listing
	if err := json.NewDecoder(io.LimitReader(resp.Body, 20<<20)).Decode(&l); err != nil {
		http.Error(w, "failed to parse reddit response: "+err.Error(), http.StatusBadGateway)
		return
	}

	out := feedResponse{After: l.Data.After, Posts: []Post{}, Host: servedHost, User: pageUser(r, clientCookie(r))}
	for _, child := range l.Data.Children {
		if child.Kind != "t3" || child.Data.Stickied || child.Data.Promoted {
			continue
		}
		if p, ok := extractPost(child.Data); ok {
			out.Posts = append(out.Posts, p)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	// Responses are per-cookie but share a URL; HTTP caches (the WebKit/
	// NSURLCache layer under iOS PWAs in particular) must never reuse them
	// across accounts.
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}

// ---------------------------------------------------------------------------
// Subscriptions: the cookie account's subscribed subreddits and followed
// users. Reddit implements "follow" as a subscription to the user's profile
// subreddit (u_<name>), so one listing serves both, split by prefix.
// ---------------------------------------------------------------------------

type subredditListing struct {
	Data struct {
		After    string `json:"after"`
		Children []struct {
			Data struct {
				DisplayName string `json:"display_name"`
			} `json:"data"`
		} `json:"children"`
	} `json:"data"`
}

// redditGetJSON fetches a reddit JSON endpoint with the usual host fallback.
func redditGetJSON(r *http.Request, path string, q url.Values, cookie string, out any) error {
	var lastErr error
	for _, host := range feedHosts {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, host+path+"?"+q.Encode(), nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			lastErr = fmt.Errorf("reddit returned %d", resp.StatusCode)
			continue
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 20<<20)).Decode(out)
		resp.Body.Close()
		return err
	}
	return lastErr
}

func handleSubscriptions(w http.ResponseWriter, r *http.Request) {
	cookie := clientCookie(r)
	if cookie == "" {
		http.Error(w, "reddit cookie required to list subscriptions — set it in settings", http.StatusUnauthorized)
		return
	}
	subreddits := []string{}
	following := []string{}
	after := ""
	for page := 0; page < 4; page++ { // up to 400 subscriptions
		q := url.Values{}
		q.Set("raw_json", "1")
		q.Set("limit", "100")
		if after != "" {
			q.Set("after", after)
		}
		var l subredditListing
		if err := redditGetJSON(r, "subreddits/mine/subscriber.json", q, cookie, &l); err != nil {
			http.Error(w, "could not list subscriptions: "+err.Error(), http.StatusBadGateway)
			return
		}
		for _, c := range l.Data.Children {
			if name, ok := strings.CutPrefix(c.Data.DisplayName, "u_"); ok {
				following = append(following, name)
			} else if c.Data.DisplayName != "" {
				subreddits = append(subreddits, c.Data.DisplayName)
			}
		}
		after = l.Data.After
		if after == "" {
			break
		}
	}
	// Leaving the loop with a live cursor means the page cap cut the
	// listing short.
	truncated := after != ""
	lessFold := func(s []string) {
		sort.Slice(s, func(i, j int) bool { return strings.ToLower(s[i]) < strings.ToLower(s[j]) })
	}
	lessFold(subreddits)
	lessFold(following)
	// The account's multireddits ride along; failing to list them must not
	// take down the subscription lists.
	type multi struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		Count int    `json:"count"`
	}
	multis := []multi{}
	var multiResp []struct {
		Data struct {
			DisplayName string `json:"display_name"`
			Path        string `json:"path"`
			Subreddits  []struct {
				Name string `json:"name"`
			} `json:"subreddits"`
		} `json:"data"`
	}
	mq := url.Values{}
	mq.Set("raw_json", "1")
	if err := redditGetJSON(r, "api/multi/mine", mq, cookie, &multiResp); err == nil {
		for _, m := range multiResp {
			path := strings.Trim(m.Data.Path, "/")
			if m.Data.DisplayName == "" || path == "" {
				continue
			}
			multis = append(multis, multi{m.Data.DisplayName, path, len(m.Data.Subreddits)})
		}
		sort.Slice(multis, func(i, j int) bool {
			return strings.ToLower(multis[i].Name) < strings.ToLower(multis[j].Name)
		})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // per-cookie, shared URL
	_ = json.NewEncoder(w).Encode(map[string]any{
		"subreddits": subreddits,
		"following":  following,
		"multis":     multis,
		// The page cap cut the listing short: consumers that treat these
		// lists as exhaustive (the home-feed community filter) must not.
		"truncated": truncated,
	})
}

// handleSearch backs the suggestion panel's reddit search. One autocomplete
// call yields subreddits and user profiles alike — profiles come back as
// t5 entries named u_<name> with subreddit_type "user".
func handleSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "q required", http.StatusBadRequest)
		return
	}
	q := url.Values{}
	q.Set("raw_json", "1")
	q.Set("query", query)
	q.Set("limit", "10")
	q.Set("include_profiles", "true")
	q.Set("include_over_18", "true")
	var l struct {
		Data struct {
			Children []struct {
				Data struct {
					DisplayName   string `json:"display_name"`
					Subscribers   int64  `json:"subscribers"`
					SubredditType string `json:"subreddit_type"`
				} `json:"data"`
			} `json:"children"`
		} `json:"data"`
	}
	if err := redditGetJSON(r, "api/subreddit_autocomplete_v2.json", q, clientCookie(r), &l); err != nil {
		http.Error(w, "search failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	type sub struct {
		Name        string `json:"name"`
		Subscribers int64  `json:"subscribers,omitempty"`
	}
	subreddits := []sub{}
	users := []string{}
	for _, c := range l.Data.Children {
		name := c.Data.DisplayName
		if stripped, ok := strings.CutPrefix(name, "u_"); ok || c.Data.SubredditType == "user" {
			if ok {
				name = stripped
			}
			users = append(users, name)
		} else if name != "" {
			subreddits = append(subreddits, sub{name, c.Data.Subscribers})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"subreddits": subreddits, "users": users})
}

// extractPost classifies a reddit post into one of our media kinds.
func extractPost(d postData) (Post, bool) {
	p := Post{
		ID:          d.ID,
		Name:        d.Name,
		Likes:       d.Likes,
		Saved:       d.Saved,
		Title:       d.Title,
		Author:      d.Author,
		Subreddit:   d.Subreddit,
		Permalink:   "https://www.reddit.com" + d.Permalink,
		NSFW:        d.Over18,
		Score:       d.Score,
		NumComments: d.NumComments,
		BodyHTML:    d.SelftextHTML,
	}

	poster := ""
	if d.Preview != nil && len(d.Preview.Images) > 0 {
		poster = d.Preview.Images[0].Source.URL
	}

	// Reddit-hosted video (also check crossposts, where media lives on the parent).
	if v := findRedditVideo(d); v != nil {
		p.Kind = "video"
		p.VideoHLS = v.HLSURL
		p.VideoMP4 = v.FallbackURL
		p.Duration = v.Duration
		p.Poster = poster
		return p, true
	}

	// Gallery posts.
	if d.IsGallery && d.GalleryData != nil {
		for _, item := range d.GalleryData.Items {
			m, ok := d.MediaMetadata[item.MediaID]
			if !ok || m.Status != "valid" {
				continue
			}
			// Gallery items render in <img>, so prefer the gif variant for
			// animated entries; the mp4 variant can't be shown in an img tag.
			switch {
			case m.Source.GIF != "":
				p.Images = append(p.Images, m.Source.GIF)
			case m.Source.URL != "":
				p.Images = append(p.Images, m.Source.URL)
			}
		}
		if len(p.Images) == 0 {
			return p, false
		}
		p.Kind = "gallery"
		return p, true
	}

	mediaURL := d.URLOverridden
	if mediaURL == "" {
		mediaURL = d.URL
	}

	// Redgifs: reddit's own transcode (reddit_video_preview) is always silent,
	// so keep the gif id for the frontend to resolve against the redgifs API,
	// with the silent transcode as fallback.
	if id := redgifsID(mediaURL); id != "" {
		p.Kind = "video"
		p.RedgifsID = id
		p.Poster = poster
		if d.Preview != nil && d.Preview.RedditVideoPreview != nil {
			p.VideoHLS = d.Preview.RedditVideoPreview.HLSURL
			p.VideoMP4 = d.Preview.RedditVideoPreview.FallbackURL
			p.Duration = d.Preview.RedditVideoPreview.Duration
		}
		return p, true
	}

	// Animated previews (e.g. imgur gifs reddit has transcoded).
	if d.Preview != nil && d.Preview.RedditVideoPreview != nil {
		v := d.Preview.RedditVideoPreview
		p.Kind = "video"
		p.VideoHLS = v.HLSURL
		p.VideoMP4 = v.FallbackURL
		p.Duration = v.Duration
		p.Poster = poster
		return p, true
	}

	// imgur .gifv is just an mp4.
	if strings.HasSuffix(mediaURL, ".gifv") && strings.Contains(mediaURL, "imgur.com") {
		p.Kind = "video"
		p.VideoMP4 = strings.TrimSuffix(mediaURL, ".gifv") + ".mp4"
		p.Poster = poster
		return p, true
	}

	// Plain images.
	if d.PostHint == "image" || hasImageExt(mediaURL) {
		p.Kind = "image"
		p.Images = []string{mediaURL}
		return p, true
	}

	// Self/text posts.
	if d.IsSelf {
		if d.Title == "" && d.Selftext == "" {
			return p, false
		}
		p.Kind = "text"
		p.Text = d.Selftext
		return p, true
	}

	// Link posts with a preview image: show the preview.
	if poster != "" {
		p.Kind = "image"
		p.Images = []string{poster}
		p.LinkURL = mediaURL
		return p, true
	}

	return p, false
}

func findRedditVideo(d postData) *redditVideo {
	for _, m := range []*mediaWrap{d.SecureMedia, d.Media} {
		if m != nil && m.RedditVideo != nil && (m.RedditVideo.HLSURL != "" || m.RedditVideo.FallbackURL != "") {
			return m.RedditVideo
		}
	}
	for _, parent := range d.CrosspostParentList {
		if v := findRedditVideo(parent); v != nil {
			return v
		}
	}
	return nil
}

func hasImageExt(u string) bool {
	u = strings.ToLower(u)
	if i := strings.Index(u, "?"); i >= 0 {
		u = u[:i]
	}
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".gif", ".webp"} {
		if strings.HasSuffix(u, ext) {
			return true
		}
	}
	return false
}
