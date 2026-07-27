package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func setupTestStore(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	old := store
	t.Cleanup(func() { store = old })
	store = &syncStore{
		path:     filepath.Join(dir, "sync.json"),
		Users:    map[string]*syncUser{},
		Sessions: map[string]*syncSession{},
	}
}

func addTestUser(t *testing.T, name string) (*syncUser, string) {
	t.Helper()
	u := &syncUser{ID: []byte(name + "-id-0123456789abcdef"), Name: name, CreatedAt: time.Now()}
	token := randomToken()
	store.mu.Lock()
	store.Users[userKey(u.ID)] = u
	store.Sessions[token] = &syncSession{UserID: u.ID, Expires: time.Now().Add(time.Hour)}
	if err := store.save(); err != nil {
		store.mu.Unlock()
		t.Fatalf("save: %v", err)
	}
	store.mu.Unlock()
	return u, token
}

func syncReq(method, path, token string, body any) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	r := httptest.NewRequest(method, path, &buf)
	if token != "" {
		r.AddCookie(&http.Cookie{Name: syncSessionCookie, Value: token})
	}
	return r
}

func TestSyncBlobRoundTripAndRevConflict(t *testing.T) {
	setupTestStore(t)
	_, token := addTestUser(t, "alice")

	// No blob yet.
	w := httptest.NewRecorder()
	handleSyncBlobGet(w, syncReq("GET", "/api/sync/blob", token, nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("empty blob: got %d", w.Code)
	}

	// First write: based on rev 0.
	w = httptest.NewRecorder()
	handleSyncBlobPut(w, syncReq("PUT", "/api/sync/blob", token, map[string]any{
		"rev": 0, "iv": "aXY=", "data": "Y2lwaGVydGV4dA==",
		"wrappedKey": map[string]string{"iv": "a2l2", "data": "a2RhdGE="},
	}))
	if w.Code != http.StatusOK {
		t.Fatalf("first put: got %d: %s", w.Code, w.Body.String())
	}
	var putResp struct{ Rev int }
	_ = json.Unmarshal(w.Body.Bytes(), &putResp)
	if putResp.Rev != 1 {
		t.Fatalf("first put rev = %d, want 1", putResp.Rev)
	}

	// Read back includes the wrapped key.
	w = httptest.NewRecorder()
	handleSyncBlobGet(w, syncReq("GET", "/api/sync/blob", token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("get: %d", w.Code)
	}
	var getResp struct {
		Blob       syncBlob    `json:"blob"`
		WrappedKey *wrappedKey `json:"wrappedKey"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &getResp)
	if getResp.Blob.Rev != 1 || getResp.Blob.Data != "Y2lwaGVydGV4dA==" || getResp.WrappedKey == nil {
		t.Fatalf("get mismatch: %+v", getResp)
	}

	// Stale write (based on rev 0 again) conflicts and returns the current blob.
	w = httptest.NewRecorder()
	handleSyncBlobPut(w, syncReq("PUT", "/api/sync/blob", token, map[string]any{
		"rev": 0, "iv": "aXY=", "data": "b3RoZXI=",
	}))
	if w.Code != http.StatusConflict {
		t.Fatalf("stale put: got %d, want 409", w.Code)
	}

	// Write based on the current rev succeeds.
	w = httptest.NewRecorder()
	handleSyncBlobPut(w, syncReq("PUT", "/api/sync/blob", token, map[string]any{
		"rev": 1, "iv": "aXY=", "data": "bmV3ZXI=",
	}))
	if w.Code != http.StatusOK {
		t.Fatalf("second put: got %d", w.Code)
	}
}

func TestSyncAuthRequired(t *testing.T) {
	setupTestStore(t)
	addTestUser(t, "bob")

	for _, tc := range []struct {
		name string
		run  func(w http.ResponseWriter, r *http.Request)
		req  *http.Request
	}{
		{"me", handleSyncMe, syncReq("GET", "/api/sync/me", "", nil)},
		{"blob get", handleSyncBlobGet, syncReq("GET", "/api/sync/blob", "bogus", nil)},
		{"blob put", handleSyncBlobPut, syncReq("PUT", "/api/sync/blob", "", map[string]any{"rev": 0, "iv": "aQ==", "data": "ZA=="})},
		{"delete", handleSyncAccountDelete, syncReq("DELETE", "/api/sync/account", "bogus", nil)},
	} {
		w := httptest.NewRecorder()
		tc.run(w, tc.req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s without session: got %d, want 401", tc.name, w.Code)
		}
	}
}

func TestSyncSessionExpiryAndLogout(t *testing.T) {
	setupTestStore(t)
	u, token := addTestUser(t, "carol")

	// Expired sessions do not resolve.
	store.mu.Lock()
	store.Sessions[token].Expires = time.Now().Add(-time.Minute)
	store.mu.Unlock()
	if got, _ := sessionUser(syncReq("GET", "/api/sync/me", token, nil)); got != nil {
		t.Fatal("expired session still resolved a user")
	}

	// Fresh session resolves, logout revokes it.
	_, token2 := addTestUser(t, "carol2")
	if got, _ := sessionUser(syncReq("GET", "/api/sync/me", token2, nil)); got == nil {
		t.Fatal("fresh session did not resolve")
	}
	w := httptest.NewRecorder()
	handleSyncLogout(w, syncReq("POST", "/api/sync/logout", token2, nil))
	if got, _ := sessionUser(syncReq("GET", "/api/sync/me", token2, nil)); got != nil {
		t.Fatal("session survived logout")
	}
	_ = u
}

func TestSyncStorePersistence(t *testing.T) {
	setupTestStore(t)
	u, _ := addTestUser(t, "dave")
	store.mu.Lock()
	store.Users[userKey(u.ID)].Blob = &syncBlob{Rev: 3, IV: "aQ==", Data: "ZA==", UpdatedAt: time.Now()}
	if err := store.save(); err != nil {
		store.mu.Unlock()
		t.Fatalf("save: %v", err)
	}
	path := store.path
	store.mu.Unlock()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	reloaded := &syncStore{}
	if err := json.Unmarshal(raw, reloaded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	ru := reloaded.Users[userKey(u.ID)]
	if ru == nil || ru.Name != "dave" || ru.Blob == nil || ru.Blob.Rev != 3 {
		t.Fatalf("reloaded store mismatch: %+v", ru)
	}
}
