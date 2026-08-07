<script>
  // Settings autosave: every control writes straight into `settings` and
  // persists on change — there is no Save/Cancel step. Side effects that the
  // old form applied on Save (feed reload on filter/cookie/server changes,
  // slide re-placement on axis flip) fire on the individual change instead.
  import { tick } from 'svelte';
  import { Switch, Checkbox } from 'bits-ui';
  import {
    settings,
    saveSettings,
    activeCookie,
    replaceSettings,
    DEFAULTS,
  } from '../lib/settings.svelte.js';
  import { P, startFeed, refreshAfterVerticalChange } from '../lib/player.svelte.js';
  import { apiBase } from '../lib/api.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { presentActionSheet } from '../lib/sheet.svelte.js';
  import {
    sync,
    syncRegister,
    syncLogin,
    syncNow,
    syncLogout,
    syncDeleteAccount,
    linking,
    startDeviceLink,
    cancelDeviceLink,
    formatLinkCode,
    fetchDeviceLink,
    authorizeDeviceLink,
  } from '../lib/syncAccount.svelte.js';
  import Icon from './Icon.svelte';
  import PickerSelect from './PickerSelect.svelte';

  const TOGGLES = [
    { key: 'vertical', label: 'Vertical navigation (swipe up/down)' },
    { key: 'smoothScroll', label: 'Smooth scrolling' },
    { key: 'showPauseIcon', label: 'Paused indicator on videos' },
    { key: 'barInvert', label: 'Left/right progress bar fills upwards' },
    { key: 'skipSeen', label: "Skip posts you've already seen" },
    { key: 'debug', label: 'Debug overlay (audio + performance)' },
  ];
  const FILTERS = [
    { key: 'showImages', label: 'Images & galleries' },
    { key: 'showVideos', label: 'Videos' },
    { key: 'showText', label: 'Text posts' },
  ];
  const FEED_KEYS = ['showImages', 'showVideos', 'showText', 'skipSeen'];

  // Which account the page is editing: an index into settings.accounts, or
  // -1 for the "add new account" entry.
  let editingAccount = $state(settings.accounts.length ? settings.activeAccount : -1);
  let accountName = $state('');
  let cookieValue = $state('');
  // The stored cookie is never shown on open — opening settings must not put
  // the credential on screen. A saved cookie renders as a masked row with a
  // Show button; the textarea (with the real value) appears only on demand.
  let cookieMasked = $state(false);
  let serverUrl = $state(settings.serverUrl);
  let imageSeconds = $state(settings.imageSeconds);
  let preloadCount = $state(settings.preloadCount);
  let ioVisible = $state(false);
  let ioValue = $state('');
  let ioEl = $state(null);

  function loadAccountFields() {
    const a = settings.accounts[editingAccount];
    accountName = a ? a.name : '';
    cookieValue = '';
    cookieMasked = !!a?.cookie;
  }
  loadAccountFields();

  // Re-derive the request cookie from the active account; a change reloads
  // the feed, since it changes what the backend returns.
  function applyActiveCookie() {
    const prev = settings.cookie;
    settings.cookie = activeCookie();
    saveSettings();
    if (prev !== settings.cookie && P.feedActive) startFeed(P.feedPath);
  }

  function createAccount(name, cookie) {
    settings.accounts.push({ name: name || `Account ${settings.accounts.length + 1}`, cookie });
    settings.activeAccount = settings.accounts.length - 1;
    editingAccount = settings.activeAccount;
    applyActiveCookie();
  }

  const accountItems = $derived([
    ...settings.accounts.map((a, i) => ({
      text: (a.name || `Account ${i + 1}`) + (i === settings.activeAccount ? ' (active)' : ''),
      value: String(i),
    })),
    { text: '+ Add account…', value: 'new' },
  ]);

  function pickAccount(v) {
    if (v === undefined || v === '') return;
    editingAccount = v === 'new' ? -1 : Number(v);
    // Picking an account makes it the active one right away.
    if (editingAccount >= 0) {
      settings.activeAccount = editingAccount;
      applyActiveCookie();
    }
    loadAccountFields();
  }

  function commitAccountName() {
    const name = accountName.trim();
    if (editingAccount >= 0) {
      const a = settings.accounts[editingAccount];
      if (!a) return;
      a.name = name || `Account ${editingAccount + 1}`;
      saveSettings();
    } else if (name) {
      // Naming the "add account" entry creates the account.
      createAccount(name, cookieMasked ? '' : cookieValue.trim());
    }
  }

  // A masked (hidden) cookie field means "unchanged". Once revealed, the
  // field is authoritative — clearing it clears the cookie.
  function commitCookie() {
    const cookie = cookieValue.trim();
    if (editingAccount >= 0) {
      const a = settings.accounts[editingAccount];
      if (!a) return;
      a.cookie = cookie;
      applyActiveCookie();
    } else if (cookie) {
      // Pasting a cookie into the "add account" entry creates the account.
      createAccount(accountName.trim(), cookie);
    }
  }

  function revealCookie() {
    cookieValue = settings.accounts[editingAccount]?.cookie || '';
    cookieMasked = false;
  }

  function deleteAccount() {
    if (editingAccount < 0) return;
    settings.accounts.splice(editingAccount, 1);
    // Deleting an entry above the active one shifts the list down; follow
    // the active ACCOUNT, not its old index — else a different account
    // silently becomes active.
    if (settings.activeAccount > editingAccount) settings.activeAccount--;
    if (settings.activeAccount >= settings.accounts.length) settings.activeAccount = 0;
    editingAccount = settings.accounts.length
      ? Math.min(editingAccount, settings.accounts.length - 1)
      : -1;
    loadAccountFields();
    showToast('Account deleted');
    applyActiveCookie();
  }

  function commitServerUrl() {
    const prevServer = apiBase();
    settings.serverUrl = String(serverUrl).trim();
    serverUrl = settings.serverUrl;
    saveSettings();
    if (apiBase() !== prevServer && P.feedActive) startFeed(P.feedPath);
  }

  function commitImageSeconds() {
    settings.imageSeconds = Math.max(1, parseFloat(imageSeconds) || DEFAULTS.imageSeconds);
    imageSeconds = settings.imageSeconds;
    saveSettings();
  }

  function commitPreloadCount() {
    settings.preloadCount = Math.max(1, Math.min(4, Math.round(preloadCount) || DEFAULTS.preloadCount));
    preloadCount = settings.preloadCount;
    saveSettings();
  }

  function applyToggle(key, value) {
    if (settings[key] === value) return;
    settings[key] = value;
    saveSettings();
    if (key === 'vertical') refreshAfterVerticalChange();
    if (FEED_KEYS.includes(key)) {
      if (!settings.showImages && !settings.showVideos && !settings.showText) {
        showToast('All post types disabled — the feed will be empty');
      }
      // The filters changed what the feed contains; reload it.
      if (P.feedActive) startFeed(P.feedPath);
    }
  }

  // Tapping the row text toggles the control, like ion-toggle labels did.
  function rowToggle(e, key) {
    if (e.target.closest('[data-switch-root], [data-checkbox-root]')) return;
    applyToggle(key, !settings[key]);
  }

  // -------------------------------------------------------------------------
  // Progress bar position: fixed to one side, or automatic (tap near a
  // screen edge to dock it there).
  // -------------------------------------------------------------------------
  const BAR_MODES = [
    { text: 'Bottom', value: 'bottom' },
    { text: 'Top', value: 'top' },
    { text: 'Left', value: 'left' },
    { text: 'Right', value: 'right' },
    { text: 'Automatic (tap near an edge)', value: 'auto' },
  ];
  function pickBarMode(v) {
    if (!v || v === settings.barMode) return;
    settings.barMode = v;
    saveSettings();
  }

  // -------------------------------------------------------------------------
  // Passkey sync
  // -------------------------------------------------------------------------
  // Device-link authorizer state: check the code first so the user can
  // compare fingerprints before any key material moves.
  let linkCodeInput = $state('');
  let linkPreview = $state(null); // { code, pubKey, fp } awaiting confirmation

  async function checkLinkCode() {
    sync.error = '';
    try {
      linkPreview = await fetchDeviceLink(linkCodeInput);
    } catch (err) {
      sync.error = String(err.message || err);
    }
  }

  async function confirmLinkCode() {
    sync.error = '';
    try {
      await authorizeDeviceLink(linkPreview);
      linkPreview = null;
      linkCodeInput = '';
      showToast('Device linked', 2000);
    } catch (err) {
      sync.error = String(err.message || err);
    }
  }

  function lastSyncLabel(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 129600) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  async function deleteSyncAccount() {
    const v = await presentActionSheet('Delete the sync account and its server data?', [
      { text: 'Delete sync account', value: 'delete' },
    ]);
    if (v === 'delete') syncDeleteAccount();
  }

  const quiet = (p) => p.catch(() => {}); // errors surface via sync.error/toasts

  // -------------------------------------------------------------------------
  // Settings export/import: move accounts + preferences between devices,
  // since localStorage is per-browser.
  // -------------------------------------------------------------------------
  async function exportSettings() {
    const json = JSON.stringify($state.snapshot(settings), null, 1);
    ioVisible = true;
    ioValue = json;
    await tick();
    ioEl?.select?.();
    navigator.clipboard
      ?.writeText(json)
      .then(() => showToast('Settings copied to clipboard'))
      .catch(() => showToast('Copy the JSON from the box below'));
  }

  async function importSettings() {
    if (!ioVisible || !ioValue.trim()) {
      ioVisible = true;
      ioValue = '';
      await tick();
      ioEl?.focus();
      showToast('Paste exported JSON, then press Import again');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(ioValue);
    } catch {
      showToast('That is not valid JSON');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      showToast('That does not look like exported settings');
      return;
    }
    replaceSettings(parsed);
    // Refresh the form's local state from the imported settings.
    serverUrl = settings.serverUrl;
    imageSeconds = settings.imageSeconds;
    preloadCount = settings.preloadCount;
    editingAccount = settings.accounts.length ? settings.activeAccount : -1;
    loadAccountFields();
    ioVisible = false;
    showToast('Settings imported');
    if (P.feedActive) startFeed(P.feedInput.trim());
  }
</script>

<section id="settings-page">
  <form id="settings-form" onsubmit={(e) => e.preventDefault()}>
    <h2>Settings</h2>

    <div class="list">
      <div class="item">
        <span class="item-label">Account</span>
        <PickerSelect
          triggerClass="account-pill"
          items={accountItems}
          value={editingAccount === -1 ? 'new' : String(editingAccount)}
          onchange={pickAccount}
        />
      </div>
      <div class="item">
        <label class="item-label" for="account-name-input">Account name</label>
        <input
          id="account-name-input"
          class="item-input"
          bind:value={accountName}
          onchange={commitAccountName}
          placeholder="e.g. main"
          autocomplete="off"
        />
      </div>
      {#if cookieMasked}
        <div class="item">
          <span class="item-label"
            >Reddit cookie saved ({settings.accounts[editingAccount]?.cookie.length || 0} chars)</span
          >
          <button type="button" class="btn-outline" onclick={revealCookie}>
            <Icon name="eye" /> Show
          </button>
        </div>
      {:else}
        <div class="item item-stacked">
          <label class="stacked-label" for="cookie-input">Reddit cookie</label>
          <textarea
            id="cookie-input"
            bind:value={cookieValue}
            onchange={commitCookie}
            rows="4"
            placeholder="Paste the FULL Cookie header from a logged-in reddit.com request (DevTools → Network → request headers). Just reddit_session usually gets blocked as a bot."
          ></textarea>
        </div>
      {/if}
      {#if editingAccount >= 0}
        <div class="item item-end">
          <button type="button" class="btn-danger" onclick={deleteAccount}>Delete this account</button>
        </div>
      {/if}
    </div>

    <div class="list">
      <div class="list-header">Sync</div>
      {#if !sync.available}
        <div class="item">
          <span class="item-label sync-note">
            Passkey sync needs the app to be served by its own backend (same origin) in a browser
            that supports passkeys.
          </span>
        </div>
      {:else if sync.loggedIn}
        <div class="item">
          <span class="item-label">
            Synced{sync.name ? ` · ${sync.name}` : ''}
            {#if sync.lastSyncAt}<span class="sync-note"> · {lastSyncLabel(sync.lastSyncAt)}</span>{/if}
          </span>
          <button type="button" class="btn-outline" disabled={sync.busy} onclick={() => syncNow()}>
            Sync now
          </button>
        </div>
        <div class="item item-stacked">
          <span class="sync-note">
            Link a device that can't use passkeys (VR headset, TV): open Settings there, tap “Link
            this device”, and enter its code here.
          </span>
          <div class="sync-actions">
            <input
              id="link-code-input"
              class="item-input"
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="Code from the other device"
              bind:value={linkCodeInput}
            />
            {#if !linkPreview}
              <button
                id="link-check-btn"
                type="button"
                class="btn-outline"
                disabled={sync.busy || !linkCodeInput.trim()}
                onclick={checkLinkCode}
              >
                Check
              </button>
            {/if}
          </div>
          {#if linkPreview}
            <span class="sync-note">
              Other device shows <strong id="link-fp-confirm">{linkPreview.fp}</strong>? Only link
              if it matches.
            </span>
            <div class="sync-actions">
              <button
                id="link-confirm-btn"
                type="button"
                class="btn-solid"
                disabled={sync.busy}
                onclick={confirmLinkCode}
              >
                Link device
              </button>
              <button type="button" class="btn-outline" onclick={() => (linkPreview = null)}>
                Cancel
              </button>
            </div>
          {/if}
        </div>
        <div class="item item-end">
          <button type="button" class="btn-outline" disabled={sync.busy} onclick={() => syncLogout()}>
            Sign out
          </button>
          <button type="button" class="btn-danger" disabled={sync.busy} onclick={deleteSyncAccount}>
            Delete sync account
          </button>
        </div>
      {:else if linking.active}
        <div class="item item-stacked">
          <span class="sync-note">
            On a device that's already signed in, open Settings and enter this code under “Link a
            device”:
          </span>
          <div class="link-code" id="link-code">{formatLinkCode(linking.code)}</div>
          <span class="sync-note">
            Verification: <strong id="link-fp-self">{linking.fp}</strong> — the other device shows
            the same letters before linking.
          </span>
          <div class="sync-actions">
            <button type="button" class="btn-outline" onclick={cancelDeviceLink}>Cancel</button>
          </div>
        </div>
      {:else}
        <div class="item item-stacked">
          <span class="sync-note">
            Sync settings, accounts and seen history across devices — end-to-end encrypted with a
            passkey. The server only ever stores ciphertext.
          </span>
          <div class="sync-actions">
            {#if sync.passkeys}
              <button
                type="button"
                class="btn-solid"
                disabled={sync.busy}
                onclick={() => quiet(syncRegister())}
              >
                Create sync passkey
              </button>
              <button
                type="button"
                class="btn-outline"
                disabled={sync.busy}
                onclick={() => quiet(syncLogin())}
              >
                Sign in
              </button>
            {/if}
            <button
              id="link-device-btn"
              type="button"
              class="btn-outline"
              disabled={sync.busy}
              onclick={() => quiet(startDeviceLink())}
            >
              Link this device
            </button>
          </div>
        </div>
      {/if}
      {#if sync.error}
        <div class="item"><span class="item-label error">{sync.error}</span></div>
      {/if}
    </div>

    <div class="list">
      <div class="item item-stacked">
        <label class="stacked-label" for="server-url-input">Backend server URL</label>
        <input
          id="server-url-input"
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          bind:value={serverUrl}
          onchange={commitServerUrl}
          placeholder="Empty = this server. Set to use a remote backend, e.g. https://redditview.example.com"
        />
      </div>
      <div class="item">
        <label class="item-label" for="image-seconds-input">Image duration (seconds)</label>
        <input
          id="image-seconds-input"
          class="item-input num"
          type="number"
          min="1"
          max="600"
          step="0.5"
          bind:value={imageSeconds}
          onchange={commitImageSeconds}
        />
      </div>
      <div class="item">
        <label class="item-label" for="preload-count-input">Posts preloaded ahead</label>
        <input
          id="preload-count-input"
          class="item-input num"
          type="number"
          min="1"
          max="4"
          step="1"
          bind:value={preloadCount}
          onchange={commitPreloadCount}
        />
      </div>
      <div class="item">
        <span class="item-label">Progress bar position</span>
        <PickerSelect
          triggerClass="bar-mode-pill"
          items={BAR_MODES}
          value={settings.barMode}
          onchange={pickBarMode}
        />
      </div>
      {#each TOGGLES as t (t.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="item item-toggle" onclick={(e) => rowToggle(e, t.key)}>
          <span class="item-label">{t.label}</span>
          <Switch.Root
            class="switch"
            checked={settings[t.key]}
            onCheckedChange={(v) => applyToggle(t.key, v)}
          >
            <Switch.Thumb class="switch-thumb" />
          </Switch.Root>
        </div>
      {/each}
    </div>

    <div class="list">
      <div class="list-header">Show post types</div>
      {#each FILTERS as f (f.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="item item-toggle" onclick={(e) => rowToggle(e, f.key)}>
          <Checkbox.Root
            class="checkbox"
            checked={settings[f.key]}
            onCheckedChange={(v) => applyToggle(f.key, v)}
          >
            <svg class="checkbox-mark" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Checkbox.Root>
          <span class="item-label">{f.label}</span>
        </div>
      {/each}
    </div>

    <div class="settings-io">
      <button type="button" class="btn-outline" onclick={exportSettings}>Export settings</button>
      <button type="button" class="btn-outline" onclick={importSettings}>Import settings</button>
    </div>
    {#if ioVisible}
      <textarea
        id="io-text"
        bind:this={ioEl}
        bind:value={ioValue}
        rows="3"
        placeholder="Exported settings JSON appears here — or paste JSON and press Import again"
      ></textarea>
    {/if}
    <p class="hint">
      Changes are saved automatically, and only in this browser's localStorage. The cookie is sent
      to the backend per request and never persisted server-side. Export includes accounts and
      cookies — treat it like a password.
    </p>
  </form>
</section>
