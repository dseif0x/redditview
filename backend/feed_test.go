package main

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestNormalizeFeedPath(t *testing.T) {
	cases := []struct {
		in       string
		wantPath string
		wantQ    string
	}{
		{"", "", ""},
		{"r/pics", "r/pics", ""},
		{"/r/pics/", "r/pics", ""},
		{"r/pics.json", "r/pics", ""},
		{"https://www.reddit.com/r/pics/top?t=week", "r/pics/top", "week"},
		{"user/foo/m/bar", "user/foo/m/bar", ""},
		{"u/someone/submitted", "u/someone/submitted", ""},
	}
	for _, c := range cases {
		path, q, err := normalizeFeedPath(c.in)
		if err != nil {
			t.Fatalf("normalizeFeedPath(%q) error: %v", c.in, err)
		}
		if path != c.wantPath {
			t.Errorf("normalizeFeedPath(%q) path = %q, want %q", c.in, path, c.wantPath)
		}
		if got := q.Get("t"); got != c.wantQ {
			t.Errorf("normalizeFeedPath(%q) t = %q, want %q", c.in, got, c.wantQ)
		}
	}
	if _, _, err := normalizeFeedPath("r/../etc"); err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestExtractPostVideo(t *testing.T) {
	raw := `{
		"id": "abc", "name": "t3_abc", "likes": true, "saved": true,
		"title": "vid", "author": "u1",
		"subreddit_name_prefixed": "r/videos", "permalink": "/r/videos/abc/",
		"secure_media": {"reddit_video": {
			"hls_url": "https://v.redd.it/x/HLSPlaylist.m3u8",
			"fallback_url": "https://v.redd.it/x/DASH_720.mp4",
			"duration": 12.5
		}}
	}`
	var d postData
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatal(err)
	}
	p, ok := extractPost(d)
	if !ok || p.Kind != "video" {
		t.Fatalf("got ok=%v kind=%q, want video", ok, p.Kind)
	}
	if p.VideoHLS == "" || p.VideoMP4 == "" || p.Duration != 12.5 {
		t.Errorf("video fields not extracted: %+v", p)
	}
	if p.Name != "t3_abc" || p.Likes == nil || !*p.Likes || !p.Saved {
		t.Errorf("vote/save fields not extracted: name=%q likes=%v saved=%v", p.Name, p.Likes, p.Saved)
	}
}

func TestFullnameValidation(t *testing.T) {
	for id, want := range map[string]bool{
		"t3_abc123": true,
		"t3_":       false,
		"t1_abc":    false,
		"abc":       false,
		"t3_ABC":    false,
		"t3_a b":    false,
	} {
		if got := fullnameRe.MatchString(id); got != want {
			t.Errorf("fullnameRe(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestExtractPostGallery(t *testing.T) {
	raw := `{
		"id": "g1", "title": "gallery", "is_gallery": true,
		"gallery_data": {"items": [{"media_id": "m2"}, {"media_id": "m1"}]},
		"media_metadata": {
			"m1": {"status": "valid", "e": "Image", "s": {"u": "https://i.redd.it/1.jpg"}},
			"m2": {"status": "valid", "e": "Image", "s": {"u": "https://i.redd.it/2.jpg"}}
		}
	}`
	var d postData
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatal(err)
	}
	p, ok := extractPost(d)
	if !ok || p.Kind != "gallery" {
		t.Fatalf("got ok=%v kind=%q, want gallery", ok, p.Kind)
	}
	// gallery_data order must be preserved
	if len(p.Images) != 2 || p.Images[0] != "https://i.redd.it/2.jpg" {
		t.Errorf("gallery order wrong: %v", p.Images)
	}
}

func TestExtractPostImageAndText(t *testing.T) {
	var img postData
	json.Unmarshal([]byte(`{"id":"i1","title":"pic","post_hint":"image","url":"https://i.redd.it/a.png"}`), &img)
	if p, ok := extractPost(img); !ok || p.Kind != "image" || p.Images[0] != "https://i.redd.it/a.png" {
		t.Errorf("image extraction failed: %+v", p)
	}

	var txt postData
	json.Unmarshal([]byte(`{"id":"t1","title":"hello","is_self":true,"selftext":"body"}`), &txt)
	if p, ok := extractPost(txt); !ok || p.Kind != "text" || p.Text != "body" {
		t.Errorf("text extraction failed: %+v", p)
	}

	var link postData
	json.Unmarshal([]byte(`{"id":"l1","title":"link","url":"https://example.com/article"}`), &link)
	if _, ok := extractPost(link); ok {
		t.Error("bare link without preview should be skipped")
	}
}

func TestRewritePlaylist(t *testing.T) {
	base, _ := url.Parse("https://v.redd.it/abc/HLSPlaylist.m3u8")
	in := "#EXTM3U\n" +
		"#EXT-X-MAP:URI=\"init.mp4\"\n" +
		"#EXTINF:4.0,\n" +
		"HLS_720_0.ts\n" +
		"https://v.redd.it/abc/HLS_AUDIO.m3u8\n"
	out := rewritePlaylist(in, base)

	for _, want := range []string{
		`URI="/api/media?u=` + url.QueryEscape("https://v.redd.it/abc/init.mp4") + `"`,
		"/api/media?u=" + url.QueryEscape("https://v.redd.it/abc/HLS_720_0.ts"),
		"/api/media?u=" + url.QueryEscape("https://v.redd.it/abc/HLS_AUDIO.m3u8"),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rewritten playlist missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "#EXTINF:4.0,") {
		t.Error("comment lines should be preserved")
	}
}

func TestRedgifsID(t *testing.T) {
	for in, want := range map[string]string{
		"https://redgifs.com/watch/AbleSpiffyHorse": "ablespiffyhorse",
		"https://www.redgifs.com/watch/somegif":     "somegif",
		"https://v3.redgifs.com/watch/SomeGif123":   "somegif123",
		"https://www.redgifs.com/ifr/somegif":       "somegif",
		"https://i.redgifs.com/i/somegif.jpg":       "somegif",
		"https://i.redd.it/x.jpg":                   "",
		"https://example.com/watch/somegif":         "",
		"https://notredgifs.com/watch/somegif":      "",
		"https://fakeredgifs.com.evil.com/watch/x":  "",
		"https://redgifs.com/users/someone":         "",
	} {
		if got := redgifsID(in); got != want {
			t.Errorf("redgifsID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractPostRedgifs(t *testing.T) {
	raw := `{
		"id": "rg1", "title": "gif", "post_hint": "rich:video",
		"url": "https://www.redgifs.com/watch/ablespiffyhorse",
		"preview": {
			"images": [{"source": {"url": "https://external-preview.redd.it/p.jpg"}}],
			"reddit_video_preview": {
				"hls_url": "https://v.redd.it/y/HLSPlaylist.m3u8",
				"fallback_url": "https://v.redd.it/y/DASH_480.mp4",
				"duration": 10
			}
		}
	}`
	var d postData
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatal(err)
	}
	p, ok := extractPost(d)
	if !ok || p.Kind != "video" {
		t.Fatalf("got ok=%v kind=%q, want video", ok, p.Kind)
	}
	if p.RedgifsID != "ablespiffyhorse" {
		t.Errorf("RedgifsID = %q", p.RedgifsID)
	}
	if p.VideoHLS == "" || p.VideoMP4 == "" {
		t.Errorf("silent fallback sources missing: %+v", p)
	}
}

func TestMediaHostAllowed(t *testing.T) {
	for host, want := range map[string]bool{
		"v.redd.it":                true,
		"i.redd.it":                true,
		"preview.redd.it":          true,
		"i.imgur.com":              true,
		"a.thumbs.redditmedia.com": true,
		"evil.com":                 false,
		"redd.it.evil.com":         false,
		"notredd.it":               false,
	} {
		if got := mediaHostAllowed(host); got != want {
			t.Errorf("mediaHostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
}
