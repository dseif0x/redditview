import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getSettings, saveSettings } from './settings';
import { colors } from './theme';

export function SettingsModal({ visible, onClose }: { visible: boolean; onClose: (changed: boolean) => void }) {
  const [serverUrl, setServerUrl] = useState(getSettings().serverUrl);
  const [cookie, setCookie] = useState(getSettings().cookie);

  const save = () => {
    saveSettings({ serverUrl: serverUrl.trim(), cookie: cookie.trim() });
    onClose(true);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => onClose(false)}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Settings</Text>

            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder={
                Platform.OS === 'web'
                  ? 'Empty = this server'
                  : 'https://redditview.example.com'
              }
              placeholderTextColor={colors.hint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="server-url"
            />

            <Text style={styles.label}>Reddit cookie</Text>
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
            <Text style={styles.hint}>
              Stored only on this device; sent per request to your server, which forwards it to reddit
              and never persists it.
            </Text>

            <View style={styles.row}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => onClose(false)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={save} testID="settings-save">
                <Text style={styles.btnText}>Save</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: '#14141c',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: '#33333f',
    padding: 20,
    paddingBottom: 34,
    maxHeight: '85%',
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 14 },
  label: { color: colors.textDim, fontSize: 13, marginBottom: 6, marginTop: 8 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  cookieInput: { minHeight: 110, textAlignVertical: 'top', fontSize: 12 },
  hint: { color: colors.hint, fontSize: 12, marginTop: 8, lineHeight: 17 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  btnText: { color: '#fff', fontWeight: '600' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#33333f' },
  btnGhostText: { color: colors.textDim, fontWeight: '600' },
});
