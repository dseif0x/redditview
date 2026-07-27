import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

// Imperative toast (replaces the web app's ion-toast). Mount <ToastHost/>
// once at the root; call toast('...') from anywhere.

let showFn: ((msg: string, ms: number) => void) | null = null;

export function toast(msg: string, ms = 3500) {
  showFn?.(msg, ms);
}

export function ToastHost() {
  const [msg, setMsg] = useState('');
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    showFn = (m, ms) => {
      setMsg(m);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start();
      }, ms);
    };
    return () => {
      showFn = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [opacity]);

  if (!msg) return null;
  return (
    <Animated.View style={[styles.toast, { opacity }]} pointerEvents="none">
      <Text style={styles.text}>{msg}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    top: 100,
    left: 20,
    right: 20,
    zIndex: 100,
    backgroundColor: 'rgba(20, 20, 28, 0.95)',
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  text: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
