// ---------------------------------------------------------------------------
// Passkey sync: server-side accounts (passkey-only, no username/password)
// that sync settings + seen history across devices, end-to-end encrypted.
//
// Crypto model:
//   passkey PRF output (only the authenticator can produce it)
//     -> HKDF-SHA256 -> KEK (key-encryption key, never stored anywhere)
//     -> unwraps the DEK (random data key; wrapped copy lives on the server,
//        raw copy is cached in this device's localStorage — the same trust
//        level as the settings it encrypts)
//   settings blob = AES-256-GCM(DEK, JSON{settings, seen, updatedAt})
// The server only ever sees ciphertext and the wrapped DEK.
// ---------------------------------------------------------------------------
import {
  settings,
  replaceSettings,
  saveSettings,
  setSettingsChangeHook,
  localUpdatedAt,
  withRemoteApply,
  seenList,
  mergeSeen,
  IS_NATIVE,
} from './settings.svelte.js';
import { apiBase } from './api.js';
import { showToast } from './toast.svelte.js';

const SYNC_KEY = 'redditview.sync';
const PRF_SALT = new TextEncoder().encode('redditview-sync-prf-v1');

export const sync = $state({
  available: false,
  loggedIn: false,
  name: '',
  lastSyncAt: 0,
  busy: false,
  error: '',
});

let dekKey = null; // cached CryptoKey for this session
let rev = 0; // last blob revision we've seen
let pushTimer = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const b64uToBuf = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bufToB64u = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64ToBuf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveLocal(v) {
  if (v) localStorage.setItem(SYNC_KEY, JSON.stringify(v));
  else localStorage.removeItem(SYNC_KEY);
}

async function syncFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------
async function kekFromPrf(prfBytes) {
  const ikm = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('redditview'),
      info: new TextEncoder().encode('settings-kek'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

async function importDek(rawB64) {
  return crypto.subtle.importKey('raw', b64ToBuf(rawB64), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function wrapDek(kek, dek) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv: bufToB64(iv), data: bufToB64(data) };
}

async function unwrapDek(kek, wrapped) {
  return crypto.subtle.unwrapKey(
    'raw',
    b64ToBuf(wrapped.data),
    kek,
    { name: 'AES-GCM', iv: b64ToBuf(wrapped.iv) },
    'AES-GCM',
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dekKey,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return { iv: bufToB64(iv), data: bufToB64(data) };
}

async function decryptPayload(blob) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(blob.iv) },
    dekKey,
    b64ToBuf(blob.data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------------------
// WebAuthn ceremonies (with the PRF extension for E2E key derivation)
// ---------------------------------------------------------------------------
function decodeCreationOptions(pk) {
  pk.challenge = b64uToBuf(pk.challenge);
  pk.user.id = b64uToBuf(pk.user.id);
  for (const c of pk.excludeCredentials || []) c.id = b64uToBuf(c.id);
  pk.extensions = { ...pk.extensions, prf: { eval: { first: PRF_SALT } } };
  return pk;
}

function decodeRequestOptions(pk) {
  pk.challenge = b64uToBuf(pk.challenge);
  for (const c of pk.allowCredentials || []) c.id = b64uToBuf(c.id);
  pk.extensions = { ...pk.extensions, prf: { eval: { first: PRF_SALT } } };
  return pk;
}

// Serialize a credential the way go-webauthn expects. The PRF output stays
// on this device — it must never reach the server.
function credentialToJSON(cred) {
  const r = cred.response;
  const out = {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: {},
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
  };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject);
    if (r.getTransports) out.response.transports = r.getTransports();
  } else {
    out.response.authenticatorData = bufToB64u(r.authenticatorData);
    out.response.signature = bufToB64u(r.signature);
    if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
  }
  return out;
}

function prfOutput(cred) {
  const first = cred.getClientExtensionResults?.()?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

// Some platforms only evaluate PRF during assertions, not at creation; run
// an immediate assertion to derive the key in that case.
async function prfViaAssertion() {
  const { flow, options } = await syncFetch('/api/sync/login/begin', { method: 'POST', body: {} });
  const cred = await navigator.credentials.get({ publicKey: decodeRequestOptions(options.publicKey) });
  await syncFetch('/api/sync/login/finish?flow=' + encodeURIComponent(flow), {
    method: 'POST',
    body: credentialToJSON(cred),
  });
  return prfOutput(cred);
}

// ---------------------------------------------------------------------------
// Payload build / apply / merge
// ---------------------------------------------------------------------------
function buildPayload() {
  return {
    settings: $state.snapshot(settings),
    seen: seenList(),
    updatedAt: localUpdatedAt() || Date.now(),
  };
}

function applyRemote(payload) {
  const localAt = localUpdatedAt();
  if (payload.settings && (payload.updatedAt || 0) > localAt) {
    withRemoteApply(() => replaceSettings(payload.settings));
  }
  mergeSeen(payload.seen);
}

// ---------------------------------------------------------------------------
// Pull / push
// ---------------------------------------------------------------------------
async function pull() {
  let res;
  try {
    res = await syncFetch('/api/sync/blob');
  } catch (err) {
    if (err.status === 404) return; // nothing uploaded yet
    throw err;
  }
  rev = res.blob.rev;
  applyRemote(await decryptPayload(res.blob));
  sync.lastSyncAt = Date.now();
  persistState();
}

async function push({ keepalive = false, includeWrappedKey = null } = {}) {
  if (!dekKey) return;
  const body = { rev, ...(await encryptPayload(buildPayload())) };
  if (includeWrappedKey) body.wrappedKey = includeWrappedKey;
  try {
    const res = await syncFetch('/api/sync/blob', { method: 'PUT', body, keepalive });
    rev = res.rev;
    sync.lastSyncAt = Date.now();
    sync.error = '';
    persistState();
  } catch (err) {
    if (err.status === 409 && err.data?.blob) {
      // Someone else wrote first: take their revision, merge, push once more.
      rev = err.data.blob.rev;
      applyRemote(await decryptPayload(err.data.blob));
      const retry = { rev, ...(await encryptPayload(buildPayload())) };
      const res = await syncFetch('/api/sync/blob', { method: 'PUT', body: retry });
      rev = res.rev;
      sync.lastSyncAt = Date.now();
      persistState();
      return;
    }
    if (err.status === 401) {
      forgetLocal(); // session expired; sign in again to resume syncing
      return;
    }
    throw err;
  }
}

function schedulePush(delayMs = 2500) {
  if (!sync.loggedIn || !dekKey) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push().catch((err) => {
      sync.error = String(err.message || err);
    });
  }, delayMs);
}

function persistState() {
  const local = loadLocal() || {};
  saveLocal({ ...local, name: sync.name, rev, lastSyncAt: sync.lastSyncAt });
}

function forgetLocal() {
  saveLocal(null);
  dekKey = null;
  rev = 0;
  sync.loggedIn = false;
  sync.name = '';
  sync.lastSyncAt = 0;
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------
async function finishKeySetup(prf, serverWrappedKey) {
  if (!prf) {
    throw new Error(
      'This passkey or browser does not support the PRF extension needed for end-to-end encryption'
    );
  }
  const kek = await kekFromPrf(prf);
  if (serverWrappedKey) {
    dekKey = await unwrapDek(kek, serverWrappedKey);
    return null; // already wrapped server-side
  }
  dekKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  return wrapDek(kek, dekKey);
}

async function cacheDek() {
  const raw = await crypto.subtle.exportKey('raw', dekKey);
  const local = loadLocal() || {};
  saveLocal({ ...local, dek: bufToB64(raw), name: sync.name, rev, lastSyncAt: sync.lastSyncAt });
}

export async function syncRegister() {
  sync.busy = true;
  sync.error = '';
  try {
    // A generic name (plus a suffix to tell multiple accounts apart in the
    // passkey picker): everything user-identifying stays inside the
    // encrypted blob, so the server never sees even a display name.
    const name = 'redditview-' + bufToB64u(crypto.getRandomValues(new Uint8Array(3)));
    const { flow, options } = await syncFetch('/api/sync/register/begin', {
      method: 'POST',
      body: { name },
    });
    const cred = await navigator.credentials.create({
      publicKey: decodeCreationOptions(options.publicKey),
    });
    const res = await syncFetch('/api/sync/register/finish?flow=' + encodeURIComponent(flow), {
      method: 'POST',
      body: credentialToJSON(cred),
    });
    let prf = prfOutput(cred);
    if (!prf) prf = await prfViaAssertion();
    const wrapped = await finishKeySetup(prf);
    sync.loggedIn = true;
    sync.name = res.name;
    rev = 0;
    await push({ includeWrappedKey: wrapped });
    await cacheDek();
    showToast('Sync passkey created — settings will sync to any device you sign in on');
  } catch (err) {
    if (err?.name !== 'NotAllowedError') sync.error = String(err.message || err);
    throw err;
  } finally {
    sync.busy = false;
  }
}

export async function syncLogin() {
  sync.busy = true;
  sync.error = '';
  try {
    const { flow, options } = await syncFetch('/api/sync/login/begin', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({
      publicKey: decodeRequestOptions(options.publicKey),
    });
    const res = await syncFetch('/api/sync/login/finish?flow=' + encodeURIComponent(flow), {
      method: 'POST',
      body: credentialToJSON(cred),
    });
    const wrapped = await finishKeySetup(prfOutput(cred), res.wrappedKey || null);
    sync.loggedIn = true;
    sync.name = res.name || '';
    if (res.blob) {
      rev = res.blob.rev;
      applyRemote(await decryptPayload(res.blob));
      sync.lastSyncAt = Date.now();
    } else {
      rev = 0;
    }
    await push({ includeWrappedKey: wrapped });
    await cacheDek();
    showToast('Signed in — settings synced');
  } catch (err) {
    if (err?.name !== 'NotAllowedError') sync.error = String(err.message || err);
    throw err;
  } finally {
    sync.busy = false;
  }
}

export async function syncNow() {
  sync.busy = true;
  sync.error = '';
  try {
    await pull();
    await push();
    showToast('Synced', 1500);
  } catch (err) {
    sync.error = String(err.message || err);
  } finally {
    sync.busy = false;
  }
}

export async function syncLogout() {
  clearTimeout(pushTimer);
  try {
    await syncFetch('/api/sync/logout', { method: 'POST', body: {} });
  } catch {
    /* signing out locally regardless */
  }
  forgetLocal();
  showToast('Signed out of sync', 1500);
}

export async function syncDeleteAccount() {
  sync.busy = true;
  try {
    await syncFetch('/api/sync/account', { method: 'DELETE' });
    forgetLocal();
    showToast('Sync account deleted');
  } catch (err) {
    sync.error = String(err.message || err);
  } finally {
    sync.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
export function initSync() {
  // Passkeys bind to the page's origin, so sync only works when the app is
  // served by its own backend (the normal web deployment) — not from the
  // native shell or a cross-origin server URL.
  sync.available =
    !IS_NATIVE && apiBase() === '' && !!window.PublicKeyCredential && !!crypto?.subtle;
  if (!sync.available) return;

  setSettingsChangeHook(() => schedulePush());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pushTimer != null) {
      clearTimeout(pushTimer);
      pushTimer = null;
      push({ keepalive: true }).catch(() => {});
    }
  });

  const local = loadLocal();
  if (!local?.dek) return;
  (async () => {
    try {
      dekKey = await importDek(local.dek);
      rev = local.rev || 0;
      const me = await syncFetch('/api/sync/me');
      sync.loggedIn = true;
      sync.name = me.name || local.name || '';
      sync.lastSyncAt = local.lastSyncAt || 0;
      await pull();
      schedulePush(1000); // publish anything changed while offline
    } catch (err) {
      if (err.status === 401) forgetLocal();
      else sync.error = String(err.message || err);
    }
  })();
}
