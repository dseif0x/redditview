package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSPreflight(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/vote", func(w http.ResponseWriter, r *http.Request) {})
	h := withCORS(mux)

	// Preflight must short-circuit before the method-specific routes.
	req := httptest.NewRequest(http.MethodOptions, "/api/vote", nil)
	req.Header.Set("Origin", "capacitor://localhost")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want %d", rr.Code, http.StatusNoContent)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin = %q, want *", got)
	}
	if got := rr.Header().Get("Access-Control-Allow-Headers"); got == "" {
		t.Error("preflight response missing Access-Control-Allow-Headers")
	}

	// Normal requests still reach the handler and carry the origin header.
	req = httptest.NewRequest(http.MethodPost, "/api/vote", nil)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want %d", rr.Code, http.StatusOK)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin on real request = %q, want *", got)
	}
}
