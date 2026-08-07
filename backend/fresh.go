package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
)

// The "fresh" pseudo-feed mixes several home listings (best, new, top of the
// day) into one deduplicated stream, Instagram-style. Big pages matter here:
// the client drops every already-seen post from this feed, and filtering a
// 25-post page can empty it — forcing refetch loops that run straight into
// reddit's rate limits. Three concurrent 100-post listings give it hundreds
// of candidates per request instead.

type freshSource struct {
	key  string
	path string
	t    string // top-listing time window
}

var freshSources = []freshSource{
	{key: "best", path: "best"},
	{key: "new", path: "new"},
	{key: "top", path: "top", t: "day"},
}

// The feed's cursor is a base64url JSON map of per-source reddit cursors.
// An empty value means that source is exhausted; "-" means it should retry
// from its start (a source that errored on its first page — a plain "" there
// would read as exhausted and silently drop it for the rest of the feed).
const freshRetryFromStart = "-"

func decodeFreshAfter(s string) map[string]string {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	m := map[string]string{}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

func encodeFreshAfter(m map[string]string) string {
	live := false
	for _, v := range m {
		if v != "" {
			live = true
		}
	}
	if !live {
		return "" // every source exhausted -> feed exhausted
	}
	raw, _ := json.Marshal(m)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// interleavePosts round-robins the source listings into one stream so each
// page mixes the algorithmic feed with genuinely new and top-of-today posts,
// deduped by fullname (the same post can chart in several listings at once).
func interleavePosts(lists [][]Post) []Post {
	taken := map[string]bool{}
	posts := []Post{}
	for n := 0; ; n++ {
		more := false
		for _, list := range lists {
			if n >= len(list) {
				continue
			}
			more = true
			p := list[n]
			if taken[p.Name] {
				continue
			}
			taken[p.Name] = true
			posts = append(posts, p)
		}
		if !more {
			break
		}
	}
	return posts
}

func handleFresh(w http.ResponseWriter, r *http.Request) {
	cookie := clientCookie(r)
	cursors := map[string]string{}
	paging := false // a later page: sources absent from the cursor map stay skipped
	if a := r.URL.Query().Get("after"); a != "" {
		cursors = decodeFreshAfter(a)
		paging = cursors != nil
	}

	type result struct {
		after string
		posts []Post
		err   error
	}
	results := make([]result, len(freshSources))
	var wg sync.WaitGroup
	for i, src := range freshSources {
		cur := cursors[src.key]
		if paging && cur == "" {
			continue // exhausted on an earlier page
		}
		if cur == freshRetryFromStart {
			cur = ""
		}
		wg.Add(1)
		go func(i int, src freshSource, cur string) {
			defer wg.Done()
			q := url.Values{}
			q.Set("raw_json", "1")
			q.Set("limit", "100")
			if src.t != "" {
				q.Set("t", src.t)
			}
			if cur != "" {
				q.Set("after", cur)
			}
			var l listing
			if err := redditGetJSON(r, src.path+"/.json", q, cookie, &l); err != nil {
				// Keep the source's position so the next page retries it.
				after := cur
				if after == "" {
					after = freshRetryFromStart
				}
				results[i] = result{after: after, err: err}
				return
			}
			posts := []Post{}
			for _, child := range l.Data.Children {
				if child.Kind != "t3" || child.Data.Stickied || child.Data.Promoted {
					continue
				}
				if p, ok := extractPost(child.Data); ok {
					posts = append(posts, p)
				}
			}
			results[i] = result{after: l.Data.After, posts: posts}
		}(i, src, cur)
	}
	wg.Wait()

	// A single failing source just sits this page out, but if every fetched
	// source failed there is nothing to serve — surface the error.
	var lastErr error
	failed := 0
	fetched := 0
	for i := range results {
		if results[i].err != nil {
			failed++
			lastErr = results[i].err
		}
		if results[i].err != nil || results[i].posts != nil {
			fetched++
		}
	}
	if fetched > 0 && failed == fetched {
		http.Error(w, "reddit request failed: "+lastErr.Error(), http.StatusBadGateway)
		return
	}

	lists := make([][]Post, len(results))
	for i := range results {
		lists[i] = results[i].posts
	}
	posts := interleavePosts(lists)

	// Skipped (exhausted) sources kept their zero value, whose "" after keeps
	// them exhausted in the next cursor.
	next := map[string]string{}
	for i, src := range freshSources {
		next[src.key] = results[i].after
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // per-cookie, shared URL
	_ = json.NewEncoder(w).Encode(feedResponse{After: encodeFreshAfter(next), Posts: posts, Host: "mix"})
}
