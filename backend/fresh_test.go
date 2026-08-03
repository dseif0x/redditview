package main

import (
	"encoding/base64"
	"testing"
)

func TestFreshCursorRoundTrip(t *testing.T) {
	m := map[string]string{"best": "t3_abc", "new": "", "top": freshRetryFromStart}
	enc := encodeFreshAfter(m)
	if enc == "" {
		t.Fatal("map with live cursors must encode non-empty")
	}
	got := decodeFreshAfter(enc)
	for k, v := range m {
		if got[k] != v {
			t.Errorf("round trip lost %s: %q, want %q", k, got[k], v)
		}
	}
	if encodeFreshAfter(map[string]string{"best": "", "new": "", "top": ""}) != "" {
		t.Error("all-exhausted map must encode to empty (feed exhausted)")
	}
	if decodeFreshAfter("!!!not-base64!!!") != nil {
		t.Error("garbage cursor must decode to nil")
	}
	if decodeFreshAfter(base64.RawURLEncoding.EncodeToString([]byte("not json"))) != nil {
		t.Error("non-JSON cursor must decode to nil")
	}
}

func TestInterleavePosts(t *testing.T) {
	p := func(name string) Post { return Post{Name: name} }
	got := interleavePosts([][]Post{
		{p("b1"), p("b2"), p("b3")},
		{p("n1"), p("b1"), p("n2"), p("n3"), p("n4")}, // b1 charts in two listings
		{},
	})
	// round 0: b1, n1 · round 1: b2 (b1 already taken) · round 2: b3, n2 ·
	// then list 2's tail
	want := []string{"b1", "n1", "b2", "b3", "n2", "n3", "n4"}
	if len(got) != len(want) {
		t.Fatalf("got %d posts, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Name != w {
			t.Errorf("posts[%d] = %q, want %q", i, got[i].Name, w)
		}
	}
}
