import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeCookie, BarPos, getSettings, replaceSettings, saveSettings } from './settings';
import { showSheet } from './components/sheets';
import { toast } from './components/Toast';
import { colors } from './theme';

// Full settings page, ported from the web app: shown by the Settings tab
// (bottom tab bar) as an opaque page over the feed, exactly like the web
// frontend's #settings-page. Multi-account cookie management (masked until
// revealed), display/behavior preferences, post type filters, and settings
// export/import.

export type SettingsResult = { changed: boolean; reloadFeed: boolean };

const BAR_POS_OPTIONS = [
  { text: 'Bottom', value: 'bottom' },
  { text: 'Top', value: 'top' },
  { text: 'Left (vertical)', value: 'left' },
  { text: 'Right (vertical)', value: 'right' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label}>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: '#33333f' }}
        thumbColor="#fff"
      />
    </Row>
  );
}

export function SettingsPage({ onClose }: { onClose: (result: SettingsResult) => void }) {
  const insets = useSafeAreaInsets();
  const s0 = getSettings();
  const [editingAccount, setEditingAccount] = useState(s0.accounts.length ? s0.activeAccount : -1);
  const [accountName, setAccountName] = useState(
    s0.accounts[s0.activeAccount]?.name ?? ''
  );
  const [cookie, setCookie] = useState('');
  const [cookieRevealed, setCookieRevealed] = useState(!s0.accounts[s0.activeAccount]?.cookie);
  const [serverUrl, setServerUrl] = useState(s0.serverUrl);
  const [imageSeconds, setImageSeconds] = useState(String(s0.imageSeconds));
  const [prefs, setPrefs] = useState({
    fillScreen: s0.fillScreen,
    vertical: s0.vertical,
    showPauseIcon: s0.showPauseIcon,
    barPos: s0.barPos,
    barInvert: s0.barInvert,
    showImages: s0.showImages,
    showVideos: s0.showVideos,
    showText: s0.showText,
    skipSeen: s0.skipSeen,
  });
  const [ioText, setIoText] = useState('');
  const [ioVisible, setIoVisible] = useState(false);

  const storedCookie = (idx: number) => getSettings().accounts[idx]?.cookie ?? '';

  const selectAccount = (idx: number) => {
    setEditingAccount(idx);
    setAccountName(idx >= 0 ? getSettings().accounts[idx]?.name ?? '' : '');
    setCookie('');
    setCookieRevealed(idx < 0 || !storedCookie(idx));
  };

  const pickAccount = async () => {
    const accounts = getSettings().accounts;
    const options = accounts.map((a, i) => ({
      text: a.name + (i === getSettings().activeAccount ? ' (active)' : ''),
      value: String(i),
    }));
    options.push({ text: '+ Add account…', value: 'new' });
    const v = await showSheet('Account', options, editingAccount >= 0 ? String(editingAccount) : 'new');
    if (v === undefined) return;
    selectAccount(v === 'new' ? -1 : Number(v));
  };

  const deleteAccount = () => {
    if (editingAccount < 0) return;
    const s = getSettings();
    const accounts = s.accounts.filter((_, i) => i !== editingAccount);
    let active = s.activeAccount >= accounts.length ? 0 : s.activeAccount;
    saveSettings({ accounts, activeAccount: active });
    selectAccount(accounts.length ? Math.min(editingAccount, accounts.length - 1) : -1);
    toast('Account deleted');
  };

  const revealCookie = () => {
    setCookie(storedCookie(editingAccount));
    setCookieRevealed(true);
  };

  const save = () => {
    const s = getSettings();
    const prevCookie = activeCookie();
    const prevServer = s.serverUrl.trim();
    const filtersChanged =
      prefs.showImages !== s.showImages ||
      prefs.showVideos !== s.showVideos ||
      prefs.showText !== s.showText ||
      prefs.skipSeen !== s.skipSeen;

    // Saving selects the edited account as the active one. A masked cookie
    // field means "unchanged"; once revealed the field is authoritative.
    const accounts = [...s.accounts];
    let active = s.activeAccount;
    const name = accountName.trim();
    const newCookie = cookieRevealed ? cookie.trim() : storedCookie(editingAccount);
    if (editingAccount === -1) {
      if (name || newCookie) {
        accounts.push({ name: name || `Account ${accounts.length + 1}`, cookie: newCookie });
        active = accounts.length - 1;
      }
    } else if (accounts[editingAccount]) {
      accounts[editingAccount] = { name: name || `Account ${editingAccount + 1}`, cookie: newCookie };
      active = editingAccount;
    }

    saveSettings({
      accounts,
      activeAccount: active,
      serverUrl: serverUrl.trim(),
      imageSeconds: Math.max(1, parseFloat(imageSeconds) || 8),
      ...prefs,
    });

    if (!prefs.showImages && !prefs.showVideos && !prefs.showText) {
      toast('All post types disabled — the feed will be empty');
    } else {
      toast('Settings saved', 1500);
    }
    onClose({
      changed: true,
      reloadFeed:
        filtersChanged || activeCookie() !== prevCookie || getSettings().serverUrl.trim() !== prevServer,
    });
  };

  const exportSettings = async () => {
    const json = JSON.stringify(getSettings(), null, 1);
    setIoText(json);
    setIoVisible(true);
    try {
      await Clipboard.setStringAsync(json);
      toast('Settings copied to clipboard');
    } catch {
      toast('Copy the JSON from the box below');
    }
  };

  const importSettings = () => {
    if (!ioVisible || !ioText.trim()) {
      setIoText('');
      setIoVisible(true);
      toast('Paste exported JSON, then press Import again');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(ioText);
    } catch {
      toast('That is not valid JSON');
      return;
    }
    try {
      replaceSettings(parsed);
    } catch (err: any) {
      toast(String(err?.message || err));
      return;
    }
    toast('Settings imported');
    onClose({ changed: true, reloadFeed: true });
  };

  const currentAccountLabel =
    editingAccount >= 0
      ? getSettings().accounts[editingAccount]?.name ?? `Account ${editingAccount + 1}`
      : '+ Add account…';
  const hasMaskedCookie = !cookieRevealed && !!storedCookie(editingAccount);

  return (
    <View style={styles.page}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inner}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 14 }]}
          >
            <Text style={styles.title}>Settings</Text>

            <Text style={styles.section}>Account</Text>
            <Pressable style={styles.pickerRow} onPress={pickAccount} testID="account-picker">
              <Text style={styles.pickerText}>{currentAccountLabel}</Text>
              <Text style={styles.pickerChevron}>▾</Text>
            </Pressable>
            <Text style={styles.label}>Account name</Text>
            <TextInput
              style={styles.input}
              value={accountName}
              onChangeText={setAccountName}
              placeholder="e.g. main"
              placeholderTextColor={colors.hint}
              autoCapitalize="none"
              autoCorrect={false}
              testID="account-name"
            />
            <Text style={styles.label}>Reddit cookie</Text>
            {hasMaskedCookie ? (
              <View style={styles.maskedRow}>
                <Text style={styles.maskedText}>
                  Cookie saved ({storedCookie(editingAccount).length} chars)
                </Text>
                <Pressable style={styles.smallBtn} onPress={revealCookie} testID="cookie-reveal">
                  <Text style={styles.smallBtnText}>Show</Text>
                </Pressable>
              </View>
            ) : (
              <TextInput
                style={[styles.input, styles.cookieInput]}
                value={cookie}
                onChangeText={setCookie}
                placeholder="Paste the FULL Cookie header from a logged-in reddit.com request (DevTools → Network). Optional for public subreddits."
                placeholderTextColor={colors.hint}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                testID="cookie"
              />
            )}
            {editingAccount >= 0 ? (
              <Pressable onPress={deleteAccount}>
                <Text style={styles.danger}>Delete this account</Text>
              </Pressable>
            ) : null}

            <Text style={styles.section}>Server</Text>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder={Platform.OS === 'web' ? 'Empty = this server' : 'https://redditview.example.com'}
              placeholderTextColor={colors.hint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="server-url"
            />

            <Text style={styles.section}>Behavior</Text>
            <Row label="Image duration (seconds)">
              <TextInput
                style={[styles.input, styles.numInput]}
                value={imageSeconds}
                onChangeText={setImageSeconds}
                keyboardType="numeric"
                testID="image-seconds"
              />
            </Row>
            <Toggle label="Fill screen (crop to fill)" value={prefs.fillScreen} onChange={(v) => setPrefs({ ...prefs, fillScreen: v })} />
            <Toggle label="Vertical navigation (swipe up/down)" value={prefs.vertical} onChange={(v) => setPrefs({ ...prefs, vertical: v })} />
            <Toggle label="Paused indicator on videos" value={prefs.showPauseIcon} onChange={(v) => setPrefs({ ...prefs, showPauseIcon: v })} />
            <Row label="Progress bar position">
              <Pressable
                style={styles.smallBtn}
                onPress={async () => {
                  const v = await showSheet('Progress bar position', BAR_POS_OPTIONS, prefs.barPos);
                  if (v !== undefined) setPrefs({ ...prefs, barPos: v as BarPos });
                }}
              >
                <Text style={styles.smallBtnText}>
                  {BAR_POS_OPTIONS.find((o) => o.value === prefs.barPos)?.text} ▾
                </Text>
              </Pressable>
            </Row>
            <Toggle label="Left/right progress bar fills upwards" value={prefs.barInvert} onChange={(v) => setPrefs({ ...prefs, barInvert: v })} />
            <Toggle label="Skip posts you've already seen" value={prefs.skipSeen} onChange={(v) => setPrefs({ ...prefs, skipSeen: v })} />

            <Text style={styles.section}>Show post types</Text>
            <Toggle label="Images & galleries" value={prefs.showImages} onChange={(v) => setPrefs({ ...prefs, showImages: v })} />
            <Toggle label="Videos" value={prefs.showVideos} onChange={(v) => setPrefs({ ...prefs, showVideos: v })} />
            <Toggle label="Text posts" value={prefs.showText} onChange={(v) => setPrefs({ ...prefs, showText: v })} />

            <Text style={styles.section}>Transfer</Text>
            <View style={styles.ioRow}>
              <Pressable style={styles.smallBtn} onPress={exportSettings} testID="export-btn">
                <Text style={styles.smallBtnText}>Export settings</Text>
              </Pressable>
              <Pressable style={styles.smallBtn} onPress={importSettings} testID="import-btn">
                <Text style={styles.smallBtnText}>Import settings</Text>
              </Pressable>
            </View>
            {ioVisible ? (
              <TextInput
                style={[styles.input, styles.cookieInput, styles.mono]}
                value={ioText}
                onChangeText={setIoText}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Exported settings JSON appears here — or paste JSON and press Import again"
                placeholderTextColor={colors.hint}
                testID="io-text"
              />
            ) : null}
            <Text style={styles.hint}>
              Everything is stored only on this device. The cookie is sent to your server per request
              and never persisted there. Export includes accounts and cookies — treat it like a
              password.
            </Text>

            <View style={styles.actions}>
              <Pressable
                style={[styles.btn, styles.btnGhost]}
                onPress={() => onClose({ changed: false, reloadFeed: false })}
              >
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={save} testID="settings-save">
                <Text style={styles.btnText}>Save</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque page over the feed, tab bar stays visible below (web parity).
  page: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, zIndex: 20 },
  fill: { flex: 1 },
  inner: { flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center' },
  content: { padding: 20, paddingBottom: 40 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 4 },
  section: { color: colors.accent, fontSize: 13, fontWeight: '700', marginTop: 18, marginBottom: 6 },
  label: { color: colors.textDim, fontSize: 13, marginBottom: 5, marginTop: 8 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
  },
  cookieInput: { minHeight: 100, textAlignVertical: 'top', fontSize: 12 },
  numInput: { width: 80, textAlign: 'center', paddingVertical: 6 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    gap: 12,
  },
  rowLabel: { color: colors.text, fontSize: 14.5, flex: 1 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickerText: { color: colors.text, fontSize: 15, flex: 1 },
  pickerChevron: { color: colors.hint },
  maskedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  maskedText: { color: colors.textDim, fontSize: 13, flex: 1 },
  smallBtn: {
    borderWidth: 1,
    borderColor: '#3a3a48',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  smallBtnText: { color: colors.textDim, fontSize: 13 },
  danger: { color: '#ff6b5e', fontSize: 13, marginTop: 10 },
  ioRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  hint: { color: colors.hint, fontSize: 12, marginTop: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  btn: { backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#33333f' },
  btnGhostText: { color: colors.textDim, fontWeight: '600' },
});
