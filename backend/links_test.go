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
