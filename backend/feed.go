package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Post is the normalized shape the frontend consumes.
type Post struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Author    string   `json:"author"`
	Subreddit string   `json:"subreddit"`
	Permalink string   `json:"permalink"`
	NSFW      bool     `json:"nsfw"`
	Kind      string   `json:"kind"` // image | gallery | video | text
	Images    []string `json:"images,omitempty"`
	VideoHLS  string   `json:"videoHls,omitempty"`
	VideoMP4  string   `json:"videoMp4,omitempty"`
	Poster    string   `json:"poster,omitempty"`
	Duration  float64  `json:"duration,omitempty"`
	Text      string   `json:"text,omitempty"`
	LinkURL   string   `json:"linkUrl,omitempty"`
}

type feedResponse struct {
	After string `json:"after"`
	Posts []Post `json:"posts"`
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
	Title         string `json:"title"`
	Author        string `json:"author"`
	Subreddit     string `json:"subreddit_name_prefixed"`
	Permalink     string `json:"permalink"`
	Over18        bool   `json:"over_18"`
	Stickied      bool   `json:"stickied"`
	IsGallery     bool   `json:"is_gallery"`
	IsSelf        bool   `json:"is_self"`
	PostHint      string `json:"post_hint"`
	URL           string `json:"url"`
	URLOverridden string `json:"url_overridden_by_dest"`
	Selftext      string `json:"selftext"`

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

func handleFeed(w http.ResponseWriter, r *http.Request) {
	path, extra, err := normalizeFeedPath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
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
		if cookie := r.Header.Get("X-Reddit-Cookie"); cookie != "" {
			req.Header.Set("Cookie", cookie)
		}

		resp, err = httpClient.Do(req)
		if err != nil {
			http.Error(w, "reddit request failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		if resp.StatusCode == http.StatusOK {
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

	out := feedResponse{After: l.Data.After, Posts: []Post{}}
	for _, child := range l.Data.Children {
		if child.Kind != "t3" || child.Data.Stickied {
			continue
		}
		if p, ok := extractPost(child.Data); ok {
			out.Posts = append(out.Posts, p)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// extractPost classifies a reddit post into one of our media kinds.
func extractPost(d postData) (Post, bool) {
	p := Post{
		ID:        d.ID,
		Title:     d.Title,
		Author:    d.Author,
		Subreddit: d.Subreddit,
		Permalink: "https://www.reddit.com" + d.Permalink,
		NSFW:      d.Over18,
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
			switch {
			case m.Source.MP4 != "":
				p.Images = append(p.Images, m.Source.MP4)
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
