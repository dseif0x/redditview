import { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VideoSource } from 'expo-video';
import { api, mediaUrl, Post } from './api';
import { colors } from './theme';

// ---------------------------------------------------------------------------
// Video: expo-video is AVPlayer on iOS — native HLS, no autoplay policies.
// Sources in preference order, like the web app: resolved redgifs mp4 (has
// audio), then HLS, then reddit's silent fallback mp4. The proxied HLS URL
// has no .m3u8 extension, so contentType must say 'hls' explicitly. On web
// there is no hls.js glue (spike), so mp4 comes first there.
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

export function VideoPost({ post, active, muted }: { post: Post; active: boolean; muted: boolean }) {
  const [src, setSrc] = useState<VideoSource>(() => videoSource(post));

  // Reddit's transcode of redgifs posts is silent; resolve the real mp4
  // via the backend. useVideoPlayer re-creates the player when the source
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
    p.loop = true;
  });

  useEffect(() => {
    player.muted = muted;
    if (active) player.play();
    else player.pause();
  }, [player, active, muted]);

  return (
    <Pressable style={styles.fill} onPress={() => (player.playing ? player.pause() : player.play())}>
      {post.poster ? (
        <Image source={{ uri: mediaUrl(post.poster) }} style={styles.media} resizeMode="contain" />
      ) : null}
      <VideoView player={player} style={styles.media} contentFit="contain" nativeControls={false} />
    </Pressable>
  );
}

export function ImagePost({ post }: { post: Post }) {
  const src = post.images?.[0];
  if (!src) return <TextPost post={post} />;
  return <Image source={{ uri: mediaUrl(src) }} style={styles.fill} resizeMode="contain" />;
}

// Gallery: a nested horizontal pager with an image counter.
export function GalleryPost({ post }: { post: Post }) {
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const images = post.images ?? [];
  return (
    <View style={styles.fill}>
      <FlatList
        data={images}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(u, i) => `${i}-${u}`}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <Image source={{ uri: mediaUrl(item) }} style={{ width, height: '100%' }} resizeMode="contain" />
        )}
      />
      <View style={styles.galleryBadge} pointerEvents="none">
        <Text style={styles.galleryBadgeText}>
          {page + 1}/{images.length}
        </Text>
      </View>
    </View>
  );
}

export function TextPost({ post }: { post: Post }) {
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.textWrap}>
      <Text style={styles.textTitle}>{post.title}</Text>
      {post.text ? <Text style={styles.textBody}>{post.text}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  media: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  galleryBadge: {
    position: 'absolute',
    top: 110,
    right: 12,
    backgroundColor: 'rgba(10,10,14,0.6)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  galleryBadgeText: { color: colors.text, fontSize: 12 },
  textWrap: { paddingTop: 130, paddingBottom: 140, paddingHorizontal: 24 },
  textTitle: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 },
  textBody: { color: colors.textDim, fontSize: 16, lineHeight: 23 },
});
