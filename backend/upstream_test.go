package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// resetUpstream isolates a test from the package-global pacing/cooldown/cache
// state (and makes the pacer effectively a no-op unless the test tunes it).
func resetUpstream(t *testing.T) {
	t.Helper()
	prevPace := redditPace
	prevFresh, prevStale := cacheFreshFor, cacheStaleFor
	redditPace = newTokenBucket(100000, 100000)
	rateCooldown.Lock()
	rateCooldown.until = time.Time{}
	rateCooldown.Unlock()
	respCache.Lock()
	respCache.m = map[string]*cacheEntry{}
	respCache.total = 0
	respCache.Unlock()
	t.Cleanup(func() {
		redditPace = prevPace
		cacheFreshFor, cacheStaleFor = prevFresh, prevStale
		rateCooldown.Lock()
		rateCooldown.until = time.Time{}
		rateCooldown.Unlock()
		respCache.Lock()
		respCache.m = map[string]*cacheEntry{}
		respCache.total = 0
		respCache.Unlock()
	})
}

func TestTokenBucketPaces(t *testing.T) {
	b := newTokenBucket(100, 1) // 1 burst, then one per 10ms
	ctx := context.Background()
	start := time.Now()
	for i := 0; i < 3; i++ {
		if err := b.wait(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if elapsed := time.Since(start); elapsed < 15*time.Millisecond {
		t.Errorf("three acquisitions took %v, want >= ~20ms (burst 1 + 2 refills)", elapsed)
	}

	// A cancelled context must abort the wait instead of sleeping.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	slow := newTokenBucket(0.001, 1)
	_ = slow.wait(context.Background()) // drain the burst token
	if err := slow.wait(cancelled); err == nil {
		t.Error("wait with cancelled context should fail")
	}
}

func TestRedditGetCachesPerCookie(t *testing.T) {
	resetUpstream(t)
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{"ok":` + r.Header.Get("Cookie") + `}`))
	}))
	defer ts.Close()

	ctx := context.Background()
	if _, err := redditGet(ctx, "1", ts.URL+"/a"); err != nil {
		t.Fatal(err)
	}
	body, err := redditGet(ctx, "1", ts.URL+"/a")
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Errorf("second identical fetch hit upstream (hits=%d), want cached", hits.Load())
	}
	if string(body) != `{"ok":1}` {
		t.Errorf("cached body = %s", body)
	}

	// Same URL, different cookie: must NOT share a cache entry.
	body, err = redditGet(ctx, "2", ts.URL+"/a")
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 || string(body) != `{"ok":2}` {
		t.Errorf("cross-cookie fetch: hits=%d body=%s", hits.Load(), body)
	}

	// The uncached variant always goes upstream.
	if _, err := redditGetUncached(ctx, "1", ts.URL+"/a"); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 3 {
		t.Errorf("uncached fetch served from cache (hits=%d)", hits.Load())
	}
}

func TestRedditGet429CooldownAndStale(t *testing.T) {
	resetUpstream(t)
	var hits atomic.Int32
	var limited atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if limited.Load() {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Write([]byte(`{"page":"` + r.URL.Path + `"}`))
	}))
	defer ts.Close()
	ctx := context.Background()

	// Prime the cache for /a, then let its fresh window lapse.
	if _, err := redditGet(ctx, "c", ts.URL+"/a"); err != nil {
		t.Fatal(err)
	}
	cacheFreshFor = 0

	// Reddit starts limiting: /a gets a real 429 upstream but serves stale.
	limited.Store(true)
	body, err := redditGet(ctx, "c", ts.URL+"/a")
	if err != nil {
		t.Fatalf("stale cache should cover the 429: %v", err)
	}
	if string(body) != `{"page":"/a"}` {
		t.Errorf("stale body = %s", body)
	}
	if hits.Load() != 2 {
		t.Fatalf("upstream hits = %d, want 2", hits.Load())
	}

	// The 429 armed the cooldown: an uncached URL now fails fast with a
	// rate-limit error and NO upstream request.
	_, err = redditGet(ctx, "c", ts.URL+"/b")
	rle, ok := err.(*rateLimitedError)
	if !ok {
		t.Fatalf("err = %v, want *rateLimitedError", err)
	}
	if rle.wait <= 0 || rle.wait > 60*time.Second {
		t.Errorf("cooldown wait = %v, want ~60s from Retry-After", rle.wait)
	}
	if hits.Load() != 2 {
		t.Errorf("request went upstream during cooldown (hits=%d)", hits.Load())
	}

	// ...but /a keeps serving stale through the whole cooldown.
	if _, err := redditGet(ctx, "c", ts.URL+"/a"); err != nil {
		t.Errorf("stale serving during cooldown failed: %v", err)
	}

	// Once the stale window is over too, /a fails like everything else.
	cacheStaleFor = 0
	if _, err := redditGet(ctx, "c", ts.URL+"/a"); err == nil {
		t.Error("expired stale entry served during cooldown")
	}
}

func TestCooldownFromRatelimitHeaders(t *testing.T) {
	resetUpstream(t)
	// A 200 whose headers say the window is nearly exhausted arms a
	// preemptive cooldown until the reset.
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{}}
	resp.Header.Set("x-ratelimit-remaining", "1.0")
	resp.Header.Set("x-ratelimit-reset", "45")
	cooldownFromResponse(resp)
	if got := cooldownRemaining(); got <= 0 || got > 45*time.Second {
		t.Errorf("preemptive cooldown = %v, want ~45s", got)
	}

	// Plenty of budget left: no cooldown.
	rateCooldown.Lock()
	rateCooldown.until = time.Time{}
	rateCooldown.Unlock()
	resp.Header.Set("x-ratelimit-remaining", "57.0")
	cooldownFromResponse(resp)
	if cooldownRemaining() != 0 {
		t.Error("cooldown armed despite remaining budget")
	}
}

func TestHandleFeedRateLimited(t *testing.T) {
	resetUpstream(t)
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer ts.Close()
	prevHosts := feedHosts
	feedHosts = []string{ts.URL + "/old/", ts.URL + "/www/"}
	t.Cleanup(func() { feedHosts = prevHosts })

	req := httptest.NewRequest(http.MethodGet, "/api/feed?path=r/pics", nil)
	rr := httptest.NewRecorder()
	handleFeed(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "rate-limiting") {
		t.Errorf("body should explain the backoff: %s", rr.Body.String())
	}
	// The first 429 must stop the host loop — no burning the fallback host.
	if hits.Load() != 1 {
		t.Errorf("upstream hits = %d, want 1 (no fallback after 429)", hits.Load())
	}
}
