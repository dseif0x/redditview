package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cookie-path hardening. Reddit rate-limits its browser JSON endpoints per
// IP, and long sessions eventually burn into 429s that only get worse when
// the app keeps retrying. Every upstream reddit call goes through this
// layer, which stacks three defenses:
//
//   1. Pacing: a token bucket smooths request bursts (the fresh feed fires
//      three listings at once; page loads stack feed + subscriptions +
//      search) so the server never looks bursty to reddit.
//   2. Cooldown: a 429 (or a rate-limit header about to hit zero) puts the
//      whole process into a cooldown honoring Retry-After. During it no
//      upstream request is sent — retrying against a limited IP just
//      deepens the penalty.
//   3. Cache: successful GET responses are cached briefly per cookie+URL,
//      so reloads (settings changes, account flips, PWA relaunches) don't
//      spend rate budget — and during a cooldown, stale cache is served so
//      the app keeps working through the window.
//
// Media/redgifs proxying does NOT go through here: CDN hosts have separate,
// far higher limits, and pacing video segments would stall playback.

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

type tokenBucket struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	rate   float64 // tokens added per second
	burst  float64
}

func newTokenBucket(rate, burst float64) *tokenBucket {
	return &tokenBucket{tokens: burst, last: time.Now(), rate: rate, burst: burst}
}

// wait blocks until a token is available or ctx ends.
func (b *tokenBucket) wait(ctx context.Context) error {
	for {
		b.mu.Lock()
		now := time.Now()
		b.tokens = math.Min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
		b.last = now
		if b.tokens >= 1 {
			b.tokens--
			b.mu.Unlock()
			return nil
		}
		need := time.Duration((1 - b.tokens) / b.rate * float64(time.Second))
		b.mu.Unlock()

		t := time.NewTimer(need)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
}

// 1 req/s sustained with a burst of 4 keeps well under reddit's informal
// pre-OAuth guideline (60/min) while letting page loads feel instant.
// REDDIT_UPSTREAM_RPS overrides the rate (burst scales along).
var redditPace = newTokenBucket(1, 4)

// ---------------------------------------------------------------------------
// 429 cooldown (process-wide: reddit limits by IP, so every cookie shares it)
// ---------------------------------------------------------------------------

var rateCooldown = struct {
	sync.Mutex
	until time.Time
}{}

func cooldownRemaining() time.Duration {
	rateCooldown.Lock()
	defer rateCooldown.Unlock()
	if d := time.Until(rateCooldown.until); d > 0 {
		return d
	}
	return 0
}

func startCooldown(d time.Duration) {
	rateCooldown.Lock()
	defer rateCooldown.Unlock()
	if until := time.Now().Add(d); until.After(rateCooldown.until) {
		rateCooldown.until = until
	}
}

// cooldownFromResponse inspects an upstream response for rate-limit signals:
// a 429's Retry-After, or reddit's x-ratelimit-remaining/-reset headers
// telling us the window is about to close (backing off one request early
// avoids ever tripping the actual 429).
func cooldownFromResponse(resp *http.Response) {
	if resp.StatusCode == http.StatusTooManyRequests {
		d := 30 * time.Second // reddit doesn't always say; be conservative
		if s, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && s > 0 {
			d = time.Duration(s) * time.Second
		}
		startCooldown(min(d, 5*time.Minute))
		return
	}
	remaining, err := strconv.ParseFloat(strings.TrimSpace(resp.Header.Get("x-ratelimit-remaining")), 64)
	if err != nil || remaining >= 2 {
		return
	}
	if reset, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("x-ratelimit-reset"))); err == nil && reset > 0 {
		startCooldown(min(time.Duration(reset)*time.Second, 5*time.Minute))
	}
}

// rateLimitedError is what callers see while the cooldown holds (and no
// cached response can cover for it).
type rateLimitedError struct{ wait time.Duration }

func (e *rateLimitedError) Error() string {
	return fmt.Sprintf("reddit is rate-limiting this server — backing off, try again in ~%ds",
		int(math.Ceil(e.wait.Seconds())))
}

// upstreamError is a non-200, non-429 reddit response.
type upstreamError struct {
	status int
	body   string // trimmed snippet for error messages
}

func (e *upstreamError) Error() string { return fmt.Sprintf("reddit returned %d", e.status) }

// sendUpstreamError maps a redditGet failure onto the client response:
// rate limiting becomes an honest 429 with the wait, anything else the
// usual 502. withTips adds the cookie/IP advice for HTML block pages
// (feed loads — the place users actually read the error).
func sendUpstreamError(w http.ResponseWriter, err error, withTips bool) {
	var rle *rateLimitedError
	if errors.As(err, &rle) {
		http.Error(w, rle.Error(), http.StatusTooManyRequests)
		return
	}
	var ue *upstreamError
	if errors.As(err, &ue) {
		msg := fmt.Sprintf("reddit returned %d", ue.status)
		switch {
		case withTips && (strings.Contains(ue.body, "<") || ue.body == ""):
			// reddit's block page is HTML; don't dump it at the user.
			msg += " (request blocked by reddit). Tips: paste your browser's FULL Cookie header in settings, not just reddit_session — reddit fingerprints requests and partial cookies look like bots. Reddit also blocks many datacenter/VPS IPs; if this server runs in a cloud, try it from a residential connection."
		case ue.body != "" && !strings.Contains(ue.body, "<"):
			msg += ": " + ue.body
		}
		http.Error(w, msg, http.StatusBadGateway)
		return
	}
	http.Error(w, "reddit request failed: "+err.Error(), http.StatusBadGateway)
}

// ---------------------------------------------------------------------------
// Short-TTL response cache
// ---------------------------------------------------------------------------

var (
	// Vars, not consts, so tests can shrink the windows.
	cacheFreshFor = 60 * time.Second // served without asking reddit at all
	cacheStaleFor = 15 * time.Minute // served only while a cooldown holds
)

const (
	cacheMaxEntry = 4 << 20  // huge comment pages aren't worth the memory
	cacheMaxTotal = 32 << 20 // process-wide budget
)

type cacheEntry struct {
	body []byte
	at   time.Time
}

var respCache = struct {
	sync.Mutex
	m     map[string]*cacheEntry
	total int
}{m: map[string]*cacheEntry{}}

// The key ties the response to the credential that fetched it — one
// account's listing must never serve another's.
func respCacheKey(cookie, target string) string {
	sum := sha256.Sum256([]byte(cookie + "\x00" + target))
	return hex.EncodeToString(sum[:])
}

func cacheGet(key string) (body []byte, age time.Duration, ok bool) {
	respCache.Lock()
	defer respCache.Unlock()
	e, ok := respCache.m[key]
	if !ok {
		return nil, 0, false
	}
	return e.body, time.Since(e.at), true
}

func cachePut(key string, body []byte) {
	if len(body) > cacheMaxEntry {
		return
	}
	respCache.Lock()
	defer respCache.Unlock()
	if old, ok := respCache.m[key]; ok {
		respCache.total -= len(old.body)
	}
	respCache.m[key] = &cacheEntry{body: body, at: time.Now()}
	respCache.total += len(body)
	for respCache.total > cacheMaxTotal {
		oldestKey := ""
		var oldestAt time.Time
		for k, e := range respCache.m {
			if oldestKey == "" || e.at.Before(oldestAt) {
				oldestKey, oldestAt = k, e.at
			}
		}
		respCache.total -= len(respCache.m[oldestKey].body)
		delete(respCache.m, oldestKey)
	}
}

// ---------------------------------------------------------------------------
// The one entry point for upstream reddit GETs
// ---------------------------------------------------------------------------

// redditGet fetches target with the cookie applied, going through cache,
// cooldown, and pacer. Returns the response body on 200; a *rateLimitedError
// when rate-limited with nothing cached to serve; a *upstreamError for other
// non-200s.
func redditGet(ctx context.Context, cookie, target string) ([]byte, error) {
	return redditGetCached(ctx, cookie, target, true)
}

// redditGetUncached skips the response cache (still paced and cooled down):
// for reads whose freshness is load-bearing, like the modhash refresh after
// reddit rejects a write — serving it the same cached /api/me would just
// replay the stale modhash.
func redditGetUncached(ctx context.Context, cookie, target string) ([]byte, error) {
	return redditGetCached(ctx, cookie, target, false)
}

func redditGetCached(ctx context.Context, cookie, target string, useCache bool) ([]byte, error) {
	key := respCacheKey(cookie, target)
	if useCache {
		if body, age, ok := cacheGet(key); ok && age <= cacheFreshFor {
			return body, nil
		}
	}
	if wait := cooldownRemaining(); wait > 0 {
		if useCache {
			if body, age, ok := cacheGet(key); ok && age <= cacheStaleFor {
				return body, nil // stale beats nothing while reddit cools off
			}
		}
		return nil, &rateLimitedError{wait}
	}
	if err := redditPace.wait(ctx); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	cooldownFromResponse(resp)

	if resp.StatusCode == http.StatusTooManyRequests {
		if useCache {
			if body, age, ok := cacheGet(key); ok && age <= cacheStaleFor {
				return body, nil
			}
		}
		return nil, &rateLimitedError{cooldownRemaining()}
	}
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, &upstreamError{status: resp.StatusCode, body: strings.TrimSpace(string(snippet))}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 30<<20))
	if err != nil {
		return nil, err
	}
	if useCache {
		cachePut(key, body)
	}
	return body, nil
}
