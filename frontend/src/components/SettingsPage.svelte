<script>
  import { tick } from 'svelte';
  import { Switch, Checkbox } from 'bits-ui';
  import {
    settings,
    saveSettings,
    activeCookie,
    replaceSettings,
    DEFAULTS,
  } from '../lib/settings.svelte.js';
  import { P, startFeed, showTab, settingsSaved } from '../lib/player.svelte.js';
  import { apiBase } from '../lib/api.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { presentActionSheet } from '../lib/sheet.svelte.js';
  import Icon from './Icon.svelte';

  const TOGGLES = [
    { key: 'fillScreen', label: 'Fill screen (crop to fill)' },
    { key: 'vertical', label: 'Vertical navigation (swipe up/down)' },
    { key: 'smoothScroll', label: 'Smooth scrolling' },
    { key: 'showPauseIcon', label: 'Paused indicator on videos' },
    { key: 'moveBar', label: 'Movable progress bar (tap near an edge)' },
    { key: 'barInvert', label: 'Left/right progress bar fills upwards' },
    { key: 'skipSeen', label: "Skip posts you've already seen" },
    { key: 'debug', label: 'Debug overlay (audio + performance)' },
  ];
  const FILTERS = [
    { key: 'showImages', label: 'Images & galleries' },
    { key: 'showVideos', label: 'Videos' },
    { key: 'showText', label: 'Text posts' },
  ];

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
  let bools = $state(
    Object.fromEntries([...TOGGLES, ...FILTERS].map(({ key }) => [key, settings[key]]))
  );
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

  const accountLabel = $derived.by(() => {
    if (editingAccount === -1) return '+ Add account…';
    const a = settings.accounts[editingAccount];
    return (
      (a?.name || `Account ${editingAccount + 1}`) +
      (editingAccount === settings.activeAccount ? ' (active)' : '')
    );
  });

  async function pickAccount() {
    const options = settings.accounts.map((a, i) => ({
      text: (a.name || `Account ${i + 1}`) + (i === settings.activeAccount ? ' (active)' : ''),
      value: String(i),
    }));
    options.push({ text: '+ Add account…', value: 'new' });
    const v = await presentActionSheet(
      'Account',
      options,
      editingAccount === -1 ? 'new' : String(editingAccount)
    );
    if (v === undefined) return;
    editingAccount = v === 'new' ? -1 : Number(v);
    loadAccountFields();
  }

  function revealCookie() {
    cookieValue = settings.accounts[editingAccount]?.cookie || '';
    cookieMasked = false;
  }

  function deleteAccount() {
    if (editingAccount < 0) return;
    settings.accounts.splice(editingAccount, 1);
    if (settings.activeAccount >= settings.accounts.length) settings.activeAccount = 0;
    editingAccount = settings.accounts.length
      ? Math.min(editingAccount, settings.accounts.length - 1)
      : -1;
    const prevCookie = settings.cookie;
    settings.cookie = activeCookie();
    saveSettings();
    loadAccountFields();
    showToast('Account deleted');
    if (prevCookie !== settings.cookie && P.feedActive) startFeed(P.feedPath);
  }

  function save() {
    const changed = (key) => settings[key] !== bools[key];
    const filtersChanged = ['showImages', 'showVideos', 'showText', 'skipSeen'].some(changed);
    const verticalChanged = changed('vertical');
    const prevCookie = settings.cookie;
    const prevServer = apiBase();

    // Saving selects the edited account as the active one.
    const name = accountName.trim();
    // A masked (hidden) cookie field means "unchanged": keep the stored value.
    // Once revealed, the field is authoritative — clearing it clears the cookie.
    const cookie = cookieMasked
      ? settings.accounts[editingAccount]?.cookie || ''
      : cookieValue.trim();
    if (editingAccount === -1) {
      if (name || cookie) {
        settings.accounts.push({ name: name || `Account ${settings.accounts.length + 1}`, cookie });
        settings.activeAccount = settings.accounts.length - 1;
      }
    } else if (settings.accounts[editingAccount]) {
      settings.accounts[editingAccount] = { name: name || `Account ${editingAccount + 1}`, cookie };
      settings.activeAccount = editingAccount;
    }
    settings.cookie = activeCookie();

    settings.serverUrl = String(serverUrl).trim();
    settings.imageSeconds = Math.max(1, parseFloat(imageSeconds) || DEFAULTS.imageSeconds);
    for (const key of Object.keys(bools)) settings[key] = bools[key];
    settingsSaved({ filtersChanged, verticalChanged, prevCookie, prevServer });
  }

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
    for (const key of Object.keys(bools)) bools[key] = settings[key];
    editingAccount = settings.accounts.length ? settings.activeAccount : -1;
    loadAccountFields();
    ioVisible = false;
    showToast('Settings imported');
    if (P.feedActive) startFeed(P.feedInput.trim());
  }

  // Tapping the row text toggles the control, like ion-toggle labels did.
  function rowToggle(e, key) {
    if (e.target.closest('[data-switch-root], [data-checkbox-root]')) return;
    bools[key] = !bools[key];
  }
</script>

<section id="settings-page">
  <form id="settings-form" onsubmit={(e) => e.preventDefault()}>
    <h2>Settings</h2>

    <div class="list">
      <div class="item">
        <span class="item-label">Account</span>
        <button type="button" class="pill account-pill" onclick={pickAccount}>{accountLabel}</button>
      </div>
      <div class="item">
        <label class="item-label" for="account-name-input">Account name</label>
        <input
          id="account-name-input"
          class="item-input"
          bind:value={accountName}
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
            <Icon name="eye-outline" /> Show
          </button>
        </div>
      {:else}
        <div class="item item-stacked">
          <label class="stacked-label" for="cookie-input">Reddit cookie</label>
          <textarea
            id="cookie-input"
            bind:value={cookieValue}
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
      <div class="item item-stacked">
        <label class="stacked-label" for="server-url-input">Backend server URL</label>
        <input
          id="server-url-input"
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          bind:value={serverUrl}
          placeholder="Empty = this server. Required in the iOS app, e.g. https://redditview.example.com"
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
        />
      </div>
      {#each TOGGLES as t (t.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="item item-toggle" onclick={(e) => rowToggle(e, t.key)}>
          <span class="item-label">{t.label}</span>
          <Switch.Root class="switch" bind:checked={bools[t.key]}>
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
          <Checkbox.Root class="checkbox" bind:checked={bools[f.key]}>
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
      Everything is stored only in this browser's localStorage. The cookie is sent to the backend
      per request and never persisted server-side. Export includes accounts and cookies — treat it
      like a password.
    </p>
    <div class="actions">
      <button type="button" class="btn-outline" onclick={() => showTab('posts')}>Cancel</button>
      <button type="button" class="btn-solid" onclick={save}>Save</button>
    </div>
  </form>
</section>
