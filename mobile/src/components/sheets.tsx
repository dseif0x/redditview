import { useEffect, useState } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SORT_BASES, SORT_TIMES } from '../sort';
import { colors } from '../theme';

// Action sheets: the real UIAlertController on iOS (system styling — glass
// on iOS 26); a dark modal list elsewhere (Android, web).

export type SheetOption = { text: string; value: string };

type PendingSheet = {
  title: string;
  options: SheetOption[];
  current?: string;
  resolve: (v: string | undefined) => void;
};

let presentFn: ((s: PendingSheet) => void) | null = null;

export function showSheet(
  title: string,
  options: SheetOption[],
  current?: string
): Promise<string | undefined> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: [...options.map((o) => (o.value === current ? `✓ ${o.text}` : o.text)), 'Cancel'],
          cancelButtonIndex: options.length,
        },
        (idx) => resolve(idx === options.length ? undefined : options[idx]?.value)
      );
    });
  }
  return new Promise((resolve) => {
    if (presentFn) presentFn({ title, options, current, resolve });
    else resolve(undefined);
  });
}

// Two SHORT sheets (sort, then time range for top/controversial), like the
// web app. Resolves with the new sort value, or undefined on cancel/no-op.
export async function pickSort(currentSort: string): Promise<string | undefined> {
  const [curBase, curTime] = (currentSort || '').split(':');
  const base = await showSheet('Sort', SORT_BASES, curBase || '');
  if (base === undefined) return undefined;
  let sort = base;
  if (base === 'top' || base === 'controversial') {
    const t = await showSheet('Time range', SORT_TIMES, base === curBase ? curTime : undefined);
    if (t === undefined) return undefined;
    sort = `${base}:${t}`;
  }
  return sort === currentSort ? undefined : sort;
}

// Fallback sheet renderer for non-iOS platforms. Mount once at the root.
export function SheetHost() {
  const [sheet, setSheet] = useState<PendingSheet | null>(null);

  useEffect(() => {
    presentFn = setSheet;
    return () => {
      presentFn = null;
    };
  }, []);

  if (!sheet) return null;
  const close = (v: string | undefined) => {
    sheet.resolve(v);
    setSheet(null);
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(undefined)}>
      <Pressable style={styles.backdrop} onPress={() => close(undefined)}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{sheet.title}</Text>
          <ScrollView style={{ flexGrow: 0 }}>
            {sheet.options.map((o) => (
              <Pressable key={o.value} style={styles.option} onPress={() => close(o.value)}>
                <Text style={[styles.optionText, o.value === sheet.current && styles.current]}>
                  {o.text}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable style={styles.option} onPress={() => close(undefined)}>
            <Text style={[styles.optionText, styles.cancel]}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
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
    paddingVertical: 10,
    paddingBottom: 26,
    maxHeight: '70%',
  },
  title: { color: colors.hint, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  option: { paddingVertical: 13, paddingHorizontal: 24 },
  optionText: { color: colors.text, fontSize: 17, textAlign: 'center' },
  current: { fontWeight: '700', color: colors.accent },
  cancel: { color: colors.hint },
});
