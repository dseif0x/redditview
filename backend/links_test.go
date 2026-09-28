package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const postPageJSON = `[
  {"kind":"Listing","data":{"after":null,"children":[
    {"kind":"t3","data":{"id":"abc123","name":"t3_abc123","title":"pinned pic","stickied":true,
      "subreddit_name_prefixed":"r/pics","permalink":"/r/pics/comments/abc123/pinned_pic/",
      "post_hint":"image","url":"https://i.redd.it/a.png"}}
  ]}},
  {"kind":"Listing","data":{"after":null,"children":[]}}
]`

func TestParseListingBody(t *testing.T) {
	l, single, err := parseListingBody([]byte(postPageJSON))
	if err != nil || !single {
		t.Fatalf("post page: single=%v err=%v", single, err)
	}
	if len(l.Data.Children) != 1 || l.Data.Children[0].Data.ID != "abc123" {
		t.Errorf("post page children = %+v", l.Data.Children)
	}
	l, single, err = parseListingBody([]byte(`{"kind":"Listing","data":{"after":"t3_x","children":[]}}`))
	if err != nil || single || l.Data.After != "t3_x" {
		t.Errorf("plain listing: single=%v after=%q err=%v", single, l.Data.After, err)
	}
	if _, _, err := parseListingBody([]byte(`[]`)); err == nil {
		t.Error("empty array should be an error")
	}
}

// A permalink typed or followed as a feed yields exactly that post — even a
// stickied one, which listings drop — and a share link resolves to it.
func TestHandleFeedSinglePostAndShareLink(t *testing.T) {
	resetUpstream(t)
	var shareHits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/r/pics/comments/abc123/.json"),
			strings.HasSuffix(r.URL.Path, "/r/pics/comments/abc123/pinned_pic/.json"):
			w.Write([]byte(postPageJSON))
		case strings.HasSuffix(r.URL.Path, "/r/pics/s/ShAre1"):
			shareHits.Add(1)
			http.Redirect(w, r, "https://www.reddit.com/r/pics/comments/abc123/pinned_pic/?share_id=zz&utm_source=share", http.StatusMovedPermanently)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	prevHosts := feedHosts
	feedHosts = []string{ts.URL + "/old/", ts.URL + "/www/"}
	t.Cleanup(func() { feedHosts = prevHosts })

	for _, path := range []string{"r/pics/comments/abc123", "r/pics/s/ShAre1", "r/pics/s/ShAre1"} {
		req := httptest.NewRequest(http.MethodGet, "/api/feed?path="+path, nil)
		rr := httptest.NewRecorder()
		handleFeed(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", path, rr.Code, rr.Body.String())
		}
		var out feedResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Posts) != 1 || out.Posts[0].ID != "abc123" || out.Posts[0].Kind != "image" {
			t.Errorf("%s: posts = %+v, want the single image post", path, out.Posts)
		}
		if out.After != "" {
			t.Errorf("%s: after = %q, want none for a single post", path, out.After)
		}
	}
	if shareHits.Load() != 1 {
		t.Errorf("share link resolved %d times, want 1 (second lookup cached)", shareHits.Load())
	}
}

func TestResolveShareLinkRejectsNonPost(t *testing.T) {
	resetUpstream(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://www.reddit.com/r/pics/wiki/index", http.StatusFound)
	}))
	defer ts.Close()
	prevHosts := feedHosts
	feedHosts = []string{ts.URL + "/old/"}
	t.Cleanup(func() { feedHosts = prevHosts })

	if _, err := resolveShareLink(t.Context(), "", "r/pics/s/NoPe"); err == nil {
		t.Error("a share link redirecting off a post page should fail")
	}
}

// Posts that look like text posts to the reader but aren't is_self: a
// crosspost of a text post, and a link post with body text.
func TestExtractPostTextLikeShapes(t *testing.T) {
	var xpost postData
	json.Unmarshal([]byte(`{"id":"x1","name":"t3_x1","title":"xpost","is_self":false,
		"url":"https://www.reddit.com/r/orig/comments/o1/original/","permalink":"/r/here/comments/x1/xpost/",
		"crosspost_parent_list":[{"id":"o1","title":"original","is_self":true,"selftext":"the body",
		  "selftext_html":"<p>the body</p>"}]}`), &xpost)
	p, ok := extractPost(xpost)
	if !ok || p.Kind != "text" || p.Text != "the body" || p.ID != "x1" || p.Name != "t3_x1" {
		t.Errorf("crossposted text post: ok=%v %+v", ok, p)
	}
	if p.BodyHTML != "<p>the body</p>" {
		t.Errorf("crosspost should inherit the parent's rendered body, got %q", p.BodyHTML)
	}

	var linkBody postData
	json.Unmarshal([]byte(`{"id":"l2","title":"link with body","is_self":false,
		"url":"https://example.com/article","selftext":"why this matters"}`), &linkBody)
	p, ok = extractPost(linkBody)
	if !ok || p.Kind != "text" || p.Text != "why this matters" || p.LinkURL != "https://example.com/article" {
		t.Errorf("link post with body: ok=%v %+v", ok, p)
	}

	// A bare link post still stays out of listings…
	var bare postData
	json.Unmarshal([]byte(`{"id":"l3","title":"bare","url":"https://example.com/x","permalink":"/r/a/comments/l3/bare/"}`), &bare)
	if _, ok := extractPost(bare); ok {
		t.Error("bare link post should be skipped in listings")
	}
	// …but opened directly it becomes a title slide with the destination.
	fb := fallbackPost(bare)
	if fb.Kind != "text" || fb.Title != "bare" || fb.LinkURL != "https://example.com/x" {
		t.Errorf("fallback post = %+v", fb)
	}
}

func TestHandleFeedSinglePostFallsBackForBareLink(t *testing.T) {
	resetUpstream(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"kind":"Listing","data":{"children":[{"kind":"t3","data":{"id":"l3","name":"t3_l3",
			"title":"bare","url":"https://example.com/x","permalink":"/r/a/comments/l3/bare/"}}]}},
			{"kind":"Listing","data":{"children":[]}}]`))
	}))
	defer ts.Close()
	prevHosts := feedHosts
	feedHosts = []string{ts.URL + "/old/"}
	t.Cleanup(func() { feedHosts = prevHosts })

	rr := httptest.NewRecorder()
	handleFeed(rr, httptest.NewRequest(http.MethodGet, "/api/feed?path=r/a/comments/l3", nil))
	var out feedResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("status %d: %v", rr.Code, err)
	}
	if len(out.Posts) != 1 || out.Posts[0].Kind != "text" || out.Posts[0].LinkURL != "https://example.com/x" {
		t.Errorf("posts = %+v, want the bare link as a text slide", out.Posts)
	}
}
