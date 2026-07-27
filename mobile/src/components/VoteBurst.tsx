import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

// Double-tap upvote burst (the web app's .vote-burst): a ▲ pops in at the
// tap point, floats up, and fades. Mount <VoteBurstHost/> once at the root;
// call voteBurst(x, y) from anywhere.

let burstFn: ((x: number, y: number) => void) | null = null;

export function voteBurst(x: number, y: number) {
  burstFn?.(x, y);
}

export function VoteBurstHost() {
  const [at, setAt] = useState<{ x: number; y: number; key: number } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    burstFn = (x, y) => {
      setAt({ x, y, key: Date.now() });
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }).start(() =>
        setAt(null)
      );
    };
    return () => {
      burstFn = null;
    };
  }, [anim]);

  if (!at) return null;
  const scale = anim.interpolate({ inputRange: [0, 0.25, 0.45, 1], outputRange: [0, 1.3, 1, 0.9] });
  const translateY = anim.interpolate({ inputRange: [0, 0.45, 1], outputRange: [0, 0, -90] });
  const opacity = anim.interpolate({ inputRange: [0, 0.15, 0.6, 1], outputRange: [0, 1, 1, 0] });
  return (
    <Animated.View
      key={at.key}
      pointerEvents="none"
      style={[
        styles.burst,
        { left: at.x - 36, top: at.y - 36, opacity, transform: [{ translateY }, { scale }] },
      ]}
    >
      <Text style={styles.arrow}>▲</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  burst: { position: 'absolute', zIndex: 60, width: 72, height: 72, alignItems: 'center', justifyContent: 'center' },
  arrow: {
    color: colors.upvote,
    fontSize: 64,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 16,
  },
});
