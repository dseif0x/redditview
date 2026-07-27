import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  GestureResponderEvent,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VideoPlayer, VideoSource } from 'expo-video';
import { api, mediaUrl, Post } from './api';
import { colors } from './theme';

// ---------------------------------------------------------------------------
// Tap handling: single taps run after a short delay so a second tap within
// the window becomes a double-tap upvote instead (same timing as the web
// app). Pressable already filters out scroll/drag gestures.
// ---------------------------------------------------------------------------
const DOUBLE_TAP_MS = 300;

export function useTaps(
  onSingle: (x: number, y: number) => void,
  onDouble: (x: number, y: number) => void
) {
  const lastTap = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return (e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      onDouble(pageX, pageY);
      return;
    }
    lastTap.current = now;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSingle(pageX, pageY);
    }, DOUBLE_TAP_MS + 30);
  };
}

// ---------------------------------------------------------------------------
// Video: expo-video is AVPlayer on iOS — native HLS, no autoplay policies.
// Sources in preference order, like the web app: resolved redgifs mp4 (has
// audio), then HLS, then reddit's silent fallback mp4. The proxied HLS URL
// has no .m3u8 extension, so contentType must say 'hls' explicitly. On web
// there is no hls.js glue, so mp4 comes first there.
// ---------------------------------------------------------------------------
function videoSource(post: Post): VideoSource {
  if (post.redgifsMp4) return { uri: mediaUrl(post.redgifsMp4) };
  if (Platform.OS !== 'web' && post.videoHls) {
    return { uri: mediaUrl(post.videoHls), contentType: 'hls' };
  }
  if (post.videoMp4) return { uri: mediaUrl(post.videoMp4) };
  if (post.videoHls) return { uri: mediaUrl(post.videoHls), contentType: 'hls' };
  return null;
}

export function VideoPost({
  post,
  active,
  muted,
  autoscroll,
  fill,
  showPauseIcon,
  onEnded,
  onProgress,
  registerPlayer,
  onDoubleTap,
  interceptTap,
}: {
  post: Post;
  active: boolean;
  muted: boolean;
  autoscroll: boolean;
  fill: boolean;
  showPauseIcon: boolean;
  onEnded: () => void;
  onProgress: (frac: number) => void;
  registerPlayer: (p: VideoPlayer | null) => void;
  onDoubleTap: (x: number, y: number) => void;
  // Returns true when the tap was consumed (e.g. edge-docking the bar).
  interceptTap?: (x: number, y: number) => boolean;
}) {
  const [src, setSrc] = useState<VideoSource>(() => videoSource(post));
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);

  // Reddit's transcode of redgifs posts is silent; resolve the real mp4 via
  // the backend. useVideoPlayer re-creates the player when the source
  // changes, so updating state is all that's needed.
  useEffect(() => {
    let cancelled = false;
    if (post.redgifsId && !post.redgifsMp4) {
      api<{ mp4?: string; poster?: string }>('/api/redgifs?id=' + encodeURIComponent(post.redgifsId))
        .then((d) => {
          if (cancelled || !d.mp4) return;
          post.redgifsMp4 = d.mp4;
          if (!post.poster && d.poster) post.poster = d.poster;
          setSrc(videoSource(post));
        })
        .catch(() => {
          /* fall through to reddit's silent transcode */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [post]);

  const player = useVideoPlayer(src, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });

  // Playback state driven by activation, like the web app's activate/
  // deactivate: previews stay paused and muted.
  useEffect(() => {
    player.loop = !autoscroll;
    player.muted = !active || muted;
    if (active) player.play();
    else player.pause();
  }, [player, active, muted, autoscroll]);

  useEffect(() => {
    if (!active) return;
    registerPlayer(player);
    const subs = [
      player.addListener('timeUpdate', (ev) => {
        const d = player.duration;
        if (d > 0) onProgress(Math.min(1, ev.currentTime / d));
      }),
      player.addListener('playToEnd', () => onEnded()),
      player.addListener('playingChange', (ev) => {
        if (ev.isPlaying) setStarted(true);
        setPaused(!ev.isPlaying);
      }),
      player.addListener('statusChange', (ev) => {
        if (ev.status === 'error') onEnded(); // unplayable: let the feed move on
      }),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      registerPlayer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, active]);

  const handleTap = useTaps((x, y) => {
    if (interceptTap?.(x, y)) return;
    if (player.playing) player.pause();
    else player.play();
  }, onDoubleTap);

  return (
    <Pressable style={styles.fill} onPress={handleTap}>
      {post.poster && !started ? (
        <Image
          source={{ uri: mediaUrl(post.poster) }}
          style={styles.media}
          resizeMode={fill ? 'cover' : 'contain'}
        />
      ) : null}
      <VideoView
        player={player}
        style={styles.media}
        contentFit={fill ? 'cover' : 'contain'}
        nativeControls={false}
        playsInline
      />
      {showPauseIcon && active && started && paused ? (
        <View style={styles.pauseWrap} pointerEvents="none">
          <View style={styles.pauseCircle}>
            <View style={styles.pauseBar} />
            <View style={styles.pauseBar} />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

export function ImagePost({
  post,
  fill,
  onSingleTap,
  onDoubleTap,
}: {
  post: Post;
  fill: boolean;
  onSingleTap: (x: number, y: number) => void;
  onDoubleTap: (x: number, y: number) => void;
}) {
  const handleTap = useTaps(onSingleTap, onDoubleTap);
  const src = post.images?.[0];
  if (!src) return <TextPost post={post} onSingleTap={onSingleTap} onDoubleTap={onDoubleTap} />;
  return (
    <Pressable style={styles.fill} onPress={handleTap}>
      <Image source={{ uri: mediaUrl(src) }} style={styles.media} resizeMode={fill ? 'cover' : 'contain'} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Gallery: all images of a post in one slide, paging along the cross axis
// (horizontal strip in a vertical feed and vice versa). step() is used by
// the autoscroll engine; returns false at the ends so the feed advances.
// ---------------------------------------------------------------------------
export type GalleryHandle = { step: (dir: 1 | -1) => boolean };

export const GalleryPost = forwardRef<
  GalleryHandle,
  {
    post: Post;
    width: number;
    height: number;
    feedVertical: boolean;
    fill: boolean;
    onPage: (page: number) => void;
    onSingleTap: (x: number, y: number) => void;
    onDoubleTap: (x: number, y: number) => void;
  }
>(function GalleryPost({ post, width, height, feedVertical, fill, onPage, onSingleTap, onDoubleTap }, ref) {
  const listRef = useRef<FlatList<string>>(null);
  const page = useRef(0);
  const images = post.images ?? [];
  const horizontal = feedVertical; // strip runs across the feed axis
  const extent = horizontal ? width : height;
  const handleTap = useTaps(onSingleTap, onDoubleTap);

  const goTo = (p: number) => {
    page.current = p;
    listRef.current?.scrollToIndex({ index: p, animated: true });
    onPage(p);
  };

  useImperativeHandle(ref, () => ({
    step: (dir) => {
      const next = page.current + dir;
      if (next < 0 || next >= images.length) return false;
      goTo(next);
      return true;
    },
  }));

  return (
    <View style={styles.fill}>
      <FlatList
        ref={listRef}
        data={images}
        horizontal={horizontal}
        pagingEnabled
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        keyExtractor={(u, i) => `${i}-${u}`}
        getItemLayout={(_, i) => ({ length: extent, offset: extent * i, index: i })}
        onMomentumScrollEnd={(e) => {
          const off = horizontal ? e.nativeEvent.contentOffset.x : e.nativeEvent.contentOffset.y;
          const p = Math.min(images.length - 1, Math.max(0, Math.round(off / extent)));
          if (p !== page.current) {
            page.current = p;
            onPage(p);
          }
        }}
        renderItem={({ item }) => (
          <Pressable onPress={handleTap}>
            <Image
              source={{ uri: mediaUrl(item) }}
              style={{ width, height }}
              resizeMode={fill ? 'cover' : 'contain'}
            />
          </Pressable>
        )}
      />
    </View>
  );
});

export function TextPost({
  post,
  onSingleTap,
  onDoubleTap,
}: {
  post: Post;
  onSingleTap: (x: number, y: number) => void;
  onDoubleTap: (x: number, y: number) => void;
}) {
  const handleTap = useTaps(onSingleTap, onDoubleTap);
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.textWrap} nestedScrollEnabled>
      <Pressable onPress={handleTap}>
        <Text style={styles.textTitle}>{post.title}</Text>
        {post.text ? <Text style={styles.textBody}>{post.text}</Text> : null}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  media: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  pauseWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(10,10,14,0.6)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  pauseBar: { width: 10, height: 29, borderRadius: 3, backgroundColor: '#fff' },
  textWrap: { paddingTop: 130, paddingBottom: 150, paddingHorizontal: 24 },
  textTitle: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 },
  textBody: { color: colors.textDim, fontSize: 16, lineHeight: 23 },
});
