import { ReactNode, useRef } from 'react';
import { Animated, GestureResponderEvent, StyleSheet, View } from 'react-native';

// Transient pinch-zoom, ported from the web app: two fingers zoom the
// post's media (anchored near the pinch midpoint), releasing springs back.
// Implemented on raw touch events so no gesture library is needed; the
// parent disables list scrolling while a pinch is active.

export function PinchZoom({
  children,
  onPinchActive,
}: {
  children: ReactNode;
  onPinchActive: (active: boolean) => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const pinch = useRef<{ dist0: number; midX0: number; midY0: number } | null>(null);
  const layout = useRef({ w: 1, h: 1 });

  const touchInfo = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return {
      dist: Math.max(20, Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)),
      midX: (a.pageX + b.pageX) / 2,
      midY: (a.pageY + b.pageY) / 2,
    };
  };

  const onTouchStart = (e: GestureResponderEvent) => {
    if (e.nativeEvent.touches.length === 2 && !pinch.current) {
      const t = touchInfo(e);
      pinch.current = { dist0: t.dist, midX0: t.midX, midY0: t.midY };
      onPinchActive(true);
    }
  };

  const onTouchMove = (e: GestureResponderEvent) => {
    if (!pinch.current || e.nativeEvent.touches.length < 2) return;
    const p = pinch.current;
    const t = touchInfo(e);
    const s = Math.min(5, Math.max(1, t.dist / p.dist0));
    scale.setValue(s);
    // RN scales about the center; translating by the midpoint delta keeps
    // the media following the fingers, which is close enough for a
    // transient spring-back zoom.
    translate.setValue({ x: t.midX - p.midX0, y: t.midY - p.midY0 });
  };

  const onTouchEnd = (e: GestureResponderEvent) => {
    if (pinch.current && e.nativeEvent.touches.length < 2) {
      pinch.current = null;
      onPinchActive(false);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 4 }),
        Animated.spring(translate, {
          toValue: { x: 0, y: 0 },
          useNativeDriver: true,
          speed: 20,
          bounciness: 4,
        }),
      ]).start();
    }
  };

  return (
    <View
      style={styles.fill}
      onLayout={(e) => (layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <Animated.View
        style={[
          styles.fill,
          { transform: [{ translateX: translate.x }, { translateY: translate.y }, { scale }] },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
