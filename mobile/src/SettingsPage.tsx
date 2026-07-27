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
import { BarPosSetting, getSettings, replaceSettings, saveSettings, Settings } from './settings';
import { showSheet } from './components/sheets';
import { toast } from './components/Toast';
import { colors } from './theme';

// Full settings page, shown by the Settings tab as an opaque page over the
// feed (like the web frontend's #settings-page). Every interaction saves
// immediately — there is no Save/Cancel; leaving the tab is "done", and the
// app decides then whether the feed needs a reload.

const BAR_POS_OPTIONS: { text: string; value: BarPosSetting }[] = [
  { text: 'Auto (tap near an edge)', value: 'auto' },
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

export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const insets = useSafeAreaInsets();
  const s0 = getSettings();
  const [editingAccount, setEditingAccount] = useState(s0.accounts.length ? s0.activeAccount : -1);
  const [accountName, setAccountName] = useState(s0.accounts[s0.activeAccount]?.name ?? '');
  const [cookie, setCookie] = useState('');
  const [cookieRevealed, setCookieRevealed] = useState(!s0.accounts[s0.activeAccount]?.cookie);
  const [serverUrl, setServerUrl] = useState(s0.serverUrl);
  const [imageSeconds, setImageSeconds] = useState(String(s0.imageSeconds));
  const [prefs, setPrefsState] = useState(s0);
  const [ioText, setIoText] = useState('');
  const [ioVisible, setIoVisible] = useState(false);

  const apply = (patch: Partial<Settings>) => {
    setPrefsState(saveSettings(patch));
    onChanged();
  };

  const toggle = (k: 'fillScreen' | 'vertical' | 'showPauseIcon' | 'barInvert' | 'skipSeen' | 'showImages' | 'showVideos' | 'showText') => ({
    value: prefs[k],
    onChange: (v: boolean) => apply({ [k]: v }),
  });

  const storedCookie = (idx: number) => getSettings().accounts[idx]?.cookie ?? '';

  const selectAccount = (idx: number, makeActive: boolean) => {
    setEditingAccount(idx);
    setAccountName(idx >= 0 ? getSettings().accounts[idx]?.name ?? '' : '');
    setCookie('');
    setCookieRevealed(idx < 0 || !storedCookie(idx));
    if (makeActive && idx >= 0) apply({ activeAccount: idx });
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
    selectAccount(v === 'new' ? -1 : Number(v), v !== 'new');
  };

  // Editing name/cookie writes straight into the account list; typing into
  // the "+ Add account" entry creates the account (as active) on the first
  // character.
  const editAccount = (patch: { name?: string; cookie?: string }) => {
    const st = getSettings();
    if (editingAccount === -1) {
      if (!(patch.name ?? '').trim() && !(patch.cookie ?? '').trim()) return;
      const accounts = [
        ...st.accounts,
        { name: (patch.name ?? '').trim() || `Account ${st.accounts.length + 1}`, cookie: patch.cookie ?? '' },
      ];
      setEditingAccount(accounts.length - 1);
      apply({ accounts, activeAccount: accounts.length - 1 });
      return;
    }
    const accounts = st.accounts.map((a, i) =>
      i === editingAccount
        ? {
            name: patch.name !== undefined ? patch.name.trim() || `Account ${i + 1}` : a.name,
            cookie: patch.cookie !== undefined ? patch.cookie.trim() : a.cookie,
          }
        : a
    );
    apply({ accounts });
  };

  const deleteAccount = () => {
    if (editingAccount < 0) return;
    const st = getSettings();
    const accounts = st.accounts.filter((_, i) => i !== editingAccount);
    const active = st.activeAccount >= accounts.length ? 0 : st.activeAccount;
    apply({ accounts, activeAccount: active });
    selectAccount(accounts.length ? Math.min(editingAccount, accounts.length - 1) : -1, false);
    toast('Account deleted');
  };

  const revealCookie = () => {
    setCookie(storedCookie(editingAccount));
    setCookieRevealed(true);
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
    // Refresh every field from the imported state.
    const st = getSettings();
    setPrefsState(st);
    setServerUrl(st.serverUrl);
    setImageSeconds(String(st.imageSeconds));
    selectAccount(st.accounts.length ? st.activeAccount : -1, false);
    setIoVisible(false);
    toast('Settings imported');
    onChanged();
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
            <Text style={styles.autosaveHint}>Changes are saved as you make them.</Text>

            <Text style={styles.section}>Account</Text>
            <Pressable style={styles.pickerRow} onPress={pickAccount} testID="account-picker">
              <Text style={styles.pickerText}>{currentAccountLabel}</Text>
              <Text style={styles.pickerChevron}>▾</Text>
            </Pressable>
            <Text style={styles.label}>Account name</Text>
            <TextInput
              style={styles.input}
              value={accountName}
              onChangeText={(v) => {
                setAccountName(v);
                editAccount({ name: v });
              }}
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
                onChangeText={(v) => {
                  setCookie(v);
                  editAccount({ cookie: v });
                }}
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
              onChangeText={(v) => {
                setServerUrl(v);
                apply({ serverUrl: v.trim() });
              }}
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
                onChangeText={(v) => {
                  setImageSeconds(v);
                  const n = parseFloat(v);
                  if (n >= 1) apply({ imageSeconds: n });
                }}
                keyboardType="numeric"
                testID="image-seconds"
              />
            </Row>
            <Toggle label="Fill screen (crop to fill)" {...toggle('fillScreen')} />
            <Toggle label="Vertical navigation (swipe up/down)" {...toggle('vertical')} />
            <Toggle label="Paused indicator on videos" {...toggle('showPauseIcon')} />
            <Row label="Progress bar position">
              <Pressable
                style={styles.smallBtn}
                testID="bar-pos"
                onPress={async () => {
                  const v = await showSheet('Progress bar position', BAR_POS_OPTIONS, prefs.barPos);
                  if (v !== undefined) apply({ barPos: v as BarPosSetting });
                }}
              >
                <Text style={styles.smallBtnText}>
                  {BAR_POS_OPTIONS.find((o) => o.value === prefs.barPos)?.text} ▾
                </Text>
              </Pressable>
            </Row>
            <Toggle label="Left/right progress bar fills upwards" {...toggle('barInvert')} />
            <Toggle label="Skip posts you've already seen" {...toggle('skipSeen')} />

            <Text style={styles.section}>Show post types</Text>
            <Toggle label="Images & galleries" {...toggle('showImages')} />
            <Toggle label="Videos" {...toggle('showVideos')} />
            <Toggle label="Text posts" {...toggle('showText')} />

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
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 2 },
  autosaveHint: { color: colors.hint, fontSize: 12 },
  section: { color: colors.accent, fontSize: 13, fontWeight: '700', marginTop: 18, marginBottom: 6 },
  label: { color: colors.textDim, fontSize: 13, marginBottom: 5, marginTop: 8 },
  input: {
    backgroundColor: '#14141c',
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
    backgroundColor: '#14141c',
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
    backgroundColor: '#14141c',
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
});
