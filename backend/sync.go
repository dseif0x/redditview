package main

// Passkey-only sync accounts. The client end-to-end encrypts its settings
// with a key derived from the passkey's PRF extension; the server only ever
// stores ciphertext (plus a wrapped copy of the data key that only the
// passkey can unwrap). Accounts are discoverable credentials — there is no
// username or password anywhere.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	syncSessionCookie = "rv_sync"
	syncSessionTTL    = 180 * 24 * time.Hour
	syncFlowTTL       = 5 * time.Minute
	syncMaxBlobBytes  = 4 << 20 // encrypted settings + seen ids; generous
)

// ---------------------------------------------------------------------------
// Store: users (with credentials, wrapped key, encrypted blob) and sessions,
// persisted as one JSON file under DATA_DIR with atomic writes.
// ---------------------------------------------------------------------------

type wrappedKey struct {
	IV   string `json:"iv"`
	Data string `json:"data"`
}

type syncBlob struct {
	Rev       int       `json:"rev"`
	IV        string    `json:"iv"`
	Data      string    `json:"data"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type syncUser struct {
	ID          []byte                `json:"id"`
	Name        string                `json:"name"`
	CreatedAt   time.Time             `json:"createdAt"`
	Credentials []webauthn.Credential `json:"credentials"`
	WrappedKey  *wrappedKey           `json:"wrappedKey,omitempty"`
	Blob        *syncBlob             `json:"blob,omitempty"`
}

func (u *syncUser) WebAuthnID() []byte                         { return u.ID }
func (u *syncUser) WebAuthnName() string                       { return u.Name }
func (u *syncUser) WebAuthnDisplayName() string                { return u.Name }
func (u *syncUser) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

type syncSession struct {
	UserID  []byte    `json:"userId"`
	Expires time.Time `json:"expires"`
}

type syncStore struct {
	mu       sync.Mutex
	path     string
	Users    map[string]*syncUser    `json:"users"`
	Sessions map[string]*syncSession `json:"sessions"`
}

var store *syncStore // nil = sync disabled (storage unavailable)

func userKey(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }

func initSyncStore() {
	dir := os.Getenv("DATA_DIR")
	if dir == "" {
		dir = "./data"
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("sync disabled: cannot create data dir %s: %v", dir, err)
		return
	}
	s := &syncStore{
		path:     filepath.Join(dir, "sync.json"),
		Users:    map[string]*syncUser{},
		Sessions: map[string]*syncSession{},
	}
	if raw, err := os.ReadFile(s.path); err == nil {
		if err := json.Unmarshal(raw, s); err != nil {
			log.Printf("sync: corrupted %s, starting fresh: %v", s.path, err)
			s.Users = map[string]*syncUser{}
			s.Sessions = map[string]*syncSession{}
		}
	}
	// Probe writability now so a read-only volume disables sync loudly at
	// startup instead of failing on the first registration.
	if err := s.save(); err != nil {
		log.Printf("sync disabled: cannot write %s: %v", s.path, err)
		return
	}
	store = s
	log.Printf("sync store: %s (%d accounts)", s.path, len(s.Users))
}

// save must be called with s.mu held (or before the store is published).
func (s *syncStore) save() error {
	now := time.Now()
	for tok, sess := range s.Sessions {
		if now.After(sess.Expires) {
			delete(s.Sessions, tok)
		}
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ---------------------------------------------------------------------------
// WebAuthn plumbing
// ---------------------------------------------------------------------------

// rpFor builds a relying party bound to the request's origin. Self-hosted
// deployments run under arbitrary domains, so the origin is derived per
// request (the browser enforces that assertions are bound to the page's real
// origin); SYNC_ORIGIN pins it explicitly for the cautious.
func rpFor(r *http.Request) (*webauthn.WebAuthn, error) {
	origin := os.Getenv("SYNC_ORIGIN")
	if origin == "" {
		origin = r.Header.Get("Origin")
	}
	if origin == "" {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		origin = scheme + "://" + r.Host
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	return webauthn.New(&webauthn.Config{
		RPID:          u.Hostname(),
		RPDisplayName: "redditview",
		RPOrigins:     []string{origin},
	})
}

// In-flight ceremony state, keyed by an opaque flow token the client echoes
// back on finish.
type syncFlow struct {
	session webauthn.SessionData
	user    *syncUser // pending registration user; nil for logins
	expires time.Time
}

var (
	flowMu sync.Mutex
	flows  = map[string]*syncFlow{}
)

func putFlow(f *syncFlow) string {
	flowMu.Lock()
	defer flowMu.Unlock()
	now := time.Now()
	for k, v := range flows {
		if now.After(v.expires) {
			delete(flows, k)
		}
	}
	tok := randomToken()
	f.expires = now.Add(syncFlowTTL)
	flows[tok] = f
	return tok
}

func takeFlow(tok string) *syncFlow {
	flowMu.Lock()
	defer flowMu.Unlock()
	f := flows[tok]
	delete(flows, tok)
	if f == nil || time.Now().After(f.expires) {
		return nil
	}
	return f
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func syncError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func requireStore(w http.ResponseWriter) bool {
	if store == nil {
		syncError(w, http.StatusServiceUnavailable, "sync storage is not available on this server")
		return false
	}
	return true
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     syncSessionCookie,
		Value:    token,
		Path:     "/api/sync",
		HttpOnly: true,
		Secure:   isSecure(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	})
}

// sessionUser resolves the request's session cookie to a user. Callers must
// not hold store.mu.
func sessionUser(r *http.Request) (*syncUser, string) {
	c, err := r.Cookie(syncSessionCookie)
	if err != nil || c.Value == "" {
		return nil, ""
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	sess := store.Sessions[c.Value]
	if sess == nil || time.Now().After(sess.Expires) {
		return nil, ""
	}
	return store.Users[userKey(sess.UserID)], c.Value
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func handleSyncRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Name == "" {
		req.Name = "redditview"
	}
	if len(req.Name) > 64 {
		req.Name = req.Name[:64]
	}
	rp, err := rpFor(r)
	if err != nil {
		syncError(w, http.StatusBadRequest, "bad origin: "+err.Error())
		return
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		syncError(w, http.StatusInternalServerError, err.Error())
		return
	}
	user := &syncUser{ID: id, Name: req.Name, CreatedAt: time.Now()}
	options, session, err := rp.BeginRegistration(user,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		syncError(w, http.StatusInternalServerError, err.Error())
		return
	}
	flow := putFlow(&syncFlow{session: *session, user: user})
	writeJSON(w, http.StatusOK, map[string]any{"flow": flow, "options": options})
}

func handleSyncRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	f := takeFlow(r.URL.Query().Get("flow"))
	if f == nil || f.user == nil {
		syncError(w, http.StatusBadRequest, "unknown or expired registration flow")
		return
	}
	rp, err := rpFor(r)
	if err != nil {
		syncError(w, http.StatusBadRequest, "bad origin: "+err.Error())
		return
	}
	cred, err := rp.FinishRegistration(f.user, f.session, r)
	if err != nil {
		syncError(w, http.StatusBadRequest, "registration failed: "+err.Error())
		return
	}
	f.user.Credentials = append(f.user.Credentials, *cred)

	token := randomToken()
	store.mu.Lock()
	store.Users[userKey(f.user.ID)] = f.user
	store.Sessions[token] = &syncSession{UserID: f.user.ID, Expires: time.Now().Add(syncSessionTTL)}
	err = store.save()
	store.mu.Unlock()
	if err != nil {
		syncError(w, http.StatusInternalServerError, "store: "+err.Error())
		return
	}
	setSessionCookie(w, r, token, int(syncSessionTTL.Seconds()))
	writeJSON(w, http.StatusOK, map[string]any{"name": f.user.Name})
}

func handleSyncLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	rp, err := rpFor(r)
	if err != nil {
		syncError(w, http.StatusBadRequest, "bad origin: "+err.Error())
		return
	}
	options, session, err := rp.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired),
	)
	if err != nil {
		syncError(w, http.StatusInternalServerError, err.Error())
		return
	}
	flow := putFlow(&syncFlow{session: *session})
	writeJSON(w, http.StatusOK, map[string]any{"flow": flow, "options": options})
}

func handleSyncLoginFinish(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	f := takeFlow(r.URL.Query().Get("flow"))
	if f == nil {
		syncError(w, http.StatusBadRequest, "unknown or expired login flow")
		return
	}
	rp, err := rpFor(r)
	if err != nil {
		syncError(w, http.StatusBadRequest, "bad origin: "+err.Error())
		return
	}
	var found *syncUser
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		store.mu.Lock()
		defer store.mu.Unlock()
		u := store.Users[userKey(userHandle)]
		if u == nil {
			return nil, protocol.ErrBadRequest.WithDetails("unknown account")
		}
		found = u
		return u, nil
	}
	_, cred, err := rp.FinishPasskeyLogin(handler, f.session, r)
	if err != nil || found == nil {
		syncError(w, http.StatusUnauthorized, "login failed")
		return
	}

	token := randomToken()
	store.mu.Lock()
	// Persist the updated sign counter / flags for the used credential.
	for i := range found.Credentials {
		if string(found.Credentials[i].ID) == string(cred.ID) {
			found.Credentials[i] = *cred
		}
	}
	store.Sessions[token] = &syncSession{UserID: found.ID, Expires: time.Now().Add(syncSessionTTL)}
	saveErr := store.save()
	resp := map[string]any{"name": found.Name}
	if found.WrappedKey != nil {
		resp["wrappedKey"] = found.WrappedKey
	}
	if found.Blob != nil {
		resp["blob"] = found.Blob
	}
	store.mu.Unlock()
	if saveErr != nil {
		syncError(w, http.StatusInternalServerError, "store: "+saveErr.Error())
		return
	}
	setSessionCookie(w, r, token, int(syncSessionTTL.Seconds()))
	writeJSON(w, http.StatusOK, resp)
}

func handleSyncMe(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	u, _ := sessionUser(r)
	if u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	store.mu.Lock()
	resp := map[string]any{"name": u.Name, "hasWrappedKey": u.WrappedKey != nil}
	if u.Blob != nil {
		resp["rev"] = u.Blob.Rev
		resp["updatedAt"] = u.Blob.UpdatedAt
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, resp)
}

func handleSyncBlobGet(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	u, _ := sessionUser(r)
	if u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if u.Blob == nil {
		syncError(w, http.StatusNotFound, "no blob yet")
		return
	}
	resp := map[string]any{"blob": u.Blob}
	if u.WrappedKey != nil {
		resp["wrappedKey"] = u.WrappedKey
	}
	writeJSON(w, http.StatusOK, resp)
}

func handleSyncBlobPut(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	u, _ := sessionUser(r)
	if u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var req struct {
		Rev        int         `json:"rev"` // the revision this write is based on
		IV         string      `json:"iv"`
		Data       string      `json:"data"`
		WrappedKey *wrappedKey `json:"wrappedKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, syncMaxBlobBytes)).Decode(&req); err != nil {
		syncError(w, http.StatusBadRequest, "bad body: "+err.Error())
		return
	}
	if req.IV == "" || req.Data == "" {
		syncError(w, http.StatusBadRequest, "missing iv/data")
		return
	}
	store.mu.Lock()
	if u.Blob != nil && u.Blob.Rev != req.Rev {
		blob := *u.Blob
		store.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"blob": blob})
		return
	}
	u.Blob = &syncBlob{Rev: req.Rev + 1, IV: req.IV, Data: req.Data, UpdatedAt: time.Now()}
	if req.WrappedKey != nil {
		u.WrappedKey = req.WrappedKey
	}
	err := store.save()
	rev := u.Blob.Rev
	store.mu.Unlock()
	if err != nil {
		syncError(w, http.StatusInternalServerError, "store: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rev": rev})
}

func handleSyncLogout(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	if c, err := r.Cookie(syncSessionCookie); err == nil {
		store.mu.Lock()
		delete(store.Sessions, c.Value)
		_ = store.save()
		store.mu.Unlock()
	}
	setSessionCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleSyncAccountDelete(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	u, _ := sessionUser(r)
	if u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	store.mu.Lock()
	delete(store.Users, userKey(u.ID))
	for tok, sess := range store.Sessions {
		if string(sess.UserID) == string(u.ID) {
			delete(store.Sessions, tok)
		}
	}
	err := store.save()
	store.mu.Unlock()
	if err != nil {
		syncError(w, http.StatusInternalServerError, "store: "+err.Error())
		return
	}
	setSessionCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func registerSyncRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/sync/register/begin", handleSyncRegisterBegin)
	mux.HandleFunc("POST /api/sync/register/finish", handleSyncRegisterFinish)
	mux.HandleFunc("POST /api/sync/login/begin", handleSyncLoginBegin)
	mux.HandleFunc("POST /api/sync/login/finish", handleSyncLoginFinish)
	mux.HandleFunc("GET /api/sync/me", handleSyncMe)
	mux.HandleFunc("GET /api/sync/blob", handleSyncBlobGet)
	mux.HandleFunc("PUT /api/sync/blob", handleSyncBlobPut)
	mux.HandleFunc("POST /api/sync/logout", handleSyncLogout)
	mux.HandleFunc("DELETE /api/sync/account", handleSyncAccountDelete)
	mux.HandleFunc("POST /api/sync/link/start", handleLinkStart)
	mux.HandleFunc("GET /api/sync/link/{code}", handleLinkGet)
	mux.HandleFunc("POST /api/sync/link/{code}", handleLinkComplete)
	mux.HandleFunc("GET /api/sync/link/{code}/claim", handleLinkClaim)
}

// ---------------------------------------------------------------------------
// Device linking: lets a device that can't do passkeys (VR headsets, TVs)
// join an existing sync account. The new device generates an ephemeral ECDH
// key and displays a short code; the user types that code into an already-
// signed-in device, which verifies the key's fingerprint and posts the
// account's key material encrypted TO that public key. The server relays
// only ciphertext (it never sees the DEK) and mints the new device a
// session when the encrypted bundle is claimed.
// ---------------------------------------------------------------------------

type linkFlow struct {
	pubKey  string          // linkee's ephemeral public key (b64 SPKI)
	payload json.RawMessage // authorizer's encrypted bundle, once posted
	token   string          // session token minted for the linkee
	expires time.Time
}

var (
	linkMu    sync.Mutex
	linkFlows = map[string]*linkFlow{}
)

const linkTTL = 10 * time.Minute

// Typable alphabet: no 0/O, 1/I/L confusables.
const linkAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func newLinkCode() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = linkAlphabet[int(v)%len(linkAlphabet)]
	}
	return string(out)
}

var linkCodeClean = regexp.MustCompile(`[^0-9A-Z]`)

func normalizeLinkCode(s string) string {
	return linkCodeClean.ReplaceAllString(strings.ToUpper(s), "")
}

func handleLinkStart(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	var body struct {
		PubKey string `json:"pubKey"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body) != nil || body.PubKey == "" || len(body.PubKey) > 400 {
		syncError(w, http.StatusBadRequest, "pubKey required")
		return
	}
	linkMu.Lock()
	defer linkMu.Unlock()
	now := time.Now()
	for k, v := range linkFlows {
		if now.After(v.expires) {
			delete(linkFlows, k)
		}
	}
	if len(linkFlows) >= 100 {
		syncError(w, http.StatusTooManyRequests, "too many pending device links")
		return
	}
	code := newLinkCode()
	linkFlows[code] = &linkFlow{pubKey: body.PubKey, expires: now.Add(linkTTL)}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

// The authorizer (signed in) looks up the code to verify the fingerprint.
func handleLinkGet(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	if u, _ := sessionUser(r); u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	code := normalizeLinkCode(r.PathValue("code"))
	linkMu.Lock()
	f := linkFlows[code]
	ok := f != nil && time.Now().Before(f.expires) && f.payload == nil
	var pk string
	if ok {
		pk = f.pubKey
	}
	linkMu.Unlock()
	if !ok {
		syncError(w, http.StatusNotFound, "link code not found or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"pubKey": pk})
}

// The authorizer posts the encrypted bundle; a session for its own account
// is minted here and handed over when the linkee claims.
func handleLinkComplete(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	u, _ := sessionUser(r)
	if u == nil {
		syncError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var body struct {
		Payload json.RawMessage `json:"payload"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body) != nil || len(body.Payload) == 0 {
		syncError(w, http.StatusBadRequest, "payload required")
		return
	}
	code := normalizeLinkCode(r.PathValue("code"))
	token := randomToken()
	store.mu.Lock()
	store.Sessions[token] = &syncSession{UserID: u.ID, Expires: time.Now().Add(syncSessionTTL)}
	err := store.save()
	store.mu.Unlock()
	if err != nil {
		syncError(w, http.StatusInternalServerError, "store: "+err.Error())
		return
	}
	linkMu.Lock()
	f := linkFlows[code]
	ok := f != nil && time.Now().Before(f.expires) && f.payload == nil
	if ok {
		f.payload = body.Payload
		f.token = token
	}
	linkMu.Unlock()
	if !ok {
		syncError(w, http.StatusNotFound, "link code not found or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// The linkee polls until the bundle arrives; claiming is one-shot and sets
// its session cookie.
func handleLinkClaim(w http.ResponseWriter, r *http.Request) {
	if !requireStore(w) {
		return
	}
	code := normalizeLinkCode(r.PathValue("code"))
	linkMu.Lock()
	f := linkFlows[code]
	if f == nil || time.Now().After(f.expires) {
		linkMu.Unlock()
		syncError(w, http.StatusNotFound, "link code not found or expired")
		return
	}
	if f.payload == nil {
		linkMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"pending": true})
		return
	}
	payload, token := f.payload, f.token
	delete(linkFlows, code)
	linkMu.Unlock()
	setSessionCookie(w, r, token, int(syncSessionTTL.Seconds()))
	writeJSON(w, http.StatusOK, map[string]any{"payload": payload})
}
