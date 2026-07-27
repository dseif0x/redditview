import { useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View, ViewStyle } from 'react-native';
import type { BarPos } from '../settings';
import { colors } from '../theme';

// Progress / seek bar, ported from the web app: docks to any screen edge
// (settings), fills along its axis (optionally inverted on vertical docks),
// and becomes a drag-to-seek control while a video is active.

export function SeekBar({
  progress,
  seekable,
  pos,
  invert,
  bottomInset,
  topInset,
  onScrub,
  onScrubEnd,
}: {
  progress: Animated.Value; // 0..1
  seekable: boolean;
  pos: BarPos;
  invert: boolean;
  bottomInset: number;
  topInset: number;
  onScrub: (frac: number) => void; // live preview while dragging
  onScrubEnd: (frac: number) => void; // commit the seek
}) {
  const vertical = pos === 'left' || pos === 'right';
  const [size, setSize] = useState(1);
  const lastFrac = useRef(0);

  // The PanResponder is created once, so it reads live values via this ref.
  const live = useRef({ seekable, vertical, invert, size, onScrub, onScrubEnd });
  live.current = { seekable, vertical, invert, size, onScrub, onScrubEnd };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.seekable,
      onMoveShouldSetPanResponder: () => live.current.seekable,
      onPanResponderGrant: (e) => {
        lastFrac.current = fracFromEvent(e.nativeEvent.locationX, e.nativeEvent.locationY);
        live.current.onScrub(lastFrac.current);
      },
      onPanResponderMove: (e) => {
        lastFrac.current = fracFromEvent(e.nativeEvent.locationX, e.nativeEvent.locationY);
        live.current.onScrub(lastFrac.current);
      },
      onPanResponderRelease: () => live.current.onScrubEnd(lastFrac.current),
      onPanResponderTerminate: () => live.current.onScrubEnd(lastFrac.current),
    })
  ).current;

  function fracFromEvent(locX: number, locY: number) {
    const l = live.current;
    let frac = l.vertical ? locY / l.size : locX / l.size;
    if (l.vertical && l.invert) frac = 1 - frac;
    return Math.min(1, Math.max(0, frac));
  }

  const pct = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  const wrap: ViewStyle =
    pos === 'bottom'
      ? { left: 0, right: 0, bottom: bottomInset, height: seekable ? 26 : 3, justifyContent: 'flex-end' }
      : pos === 'top'
        ? { left: 0, right: 0, top: topInset, height: seekable ? 26 : 3, justifyContent: 'flex-start' }
        : {
            top: '20%',
            bottom: '20%',
            width: seekable ? 26 : 3,
            ...(pos === 'left' ? { left: 0, alignItems: 'flex-start' } : { right: 0, alignItems: 'flex-end' }),
          };

  const track: ViewStyle = vertical
    ? { width: seekable ? 5 : 3, height: '100%' }
    : { height: seekable ? 5 : 3, width: '100%' };

  const fill: ViewStyle = vertical
    ? invert
      ? { width: '100%', position: 'absolute', bottom: 0 }
      : { width: '100%', position: 'absolute', top: 0 }
    : { height: '100%', position: 'absolute', left: 0 };

  return (
    <View
      style={[styles.wrap, wrap]}
      pointerEvents={seekable ? 'auto' : 'none'}
      onLayout={(e) => setSize(vertical ? e.nativeEvent.layout.height : e.nativeEvent.layout.width)}
      {...responder.panHandlers}
    >
      <View style={[styles.track, track, seekable && styles.trackSeekable]}>
        <Animated.View style={[styles.fill, fill, vertical ? { height: pct } : { width: pct }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 12 },
  track: { backgroundColor: 'rgba(255,255,255,0.10)' },
  trackSeekable: { backgroundColor: 'rgba(255,255,255,0.22)' },
  fill: { backgroundColor: colors.accent },
});
