import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewToken,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, FeedPage, Post } from './src/api';
import { GalleryPost, ImagePost, TextPost, VideoPost } from './src/PostViews';
import { initPWA } from './src/pwa';
import { SettingsModal } from './src/SettingsModal';
import { getSettings, loadSettings, saveSettings } from './src/settings';
import { colors } from './src/theme';

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') console.warn(`${title}: ${msg}`);
  else Alert.alert(title, msg);
}

function Feed() {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedInput, setFeedInput] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [listHeight, setListHeight] = useState(0);
  const after = useRef<string | null>(null);
  const fetching = useRef(false);
  const listRef = useRef<FlatList<Post>>(null);

  // Load persisted settings. Native needs a server URL, so first launch
  // opens settings; on web an empty URL means same origin (the backend
  // serving this app), so only a truly fresh visit shows the empty state.
  useEffect(() => {
    initPWA();
    loadSettings().then((s) => {
      setFeedInput(s.feed);
      setReady(true);
      if (Platform.OS !== 'web' && !s.serverUrl) setSettingsOpen(true);
      else if (Platform.OS !== 'web' || s.feed || s.cookie || s.serverUrl) loadFeed(s.feed);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPage = async (path: string): Promise<Post[]> => {
    const params = new URLSearchParams({ path });
    if (after.current) params.set('after', after.current);
    const data = await api<FeedPage>('/api/feed?' + params.toString());
    after.current = data.after || null;
    return data.posts;
  };

  const loadFeed = async (path: string) => {
    saveSettings({ feed: path });
    after.current = null;
    fetching.current = true;
    setError('');
    setLoading(true);
    setPosts([]);
    setActiveIndex(0);
    try {
      const first = await fetchPage(path);
      setPosts(first);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      if (first.length === 0) setError('No viewable posts in this feed.');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
      fetching.current = false;
    }
  };

  const loadMore = async () => {
    if (fetching.current || !after.current) return;
    fetching.current = true;
    try {
      const more = await fetchPage(getSettings().feed);
      setPosts((cur) => {
        const seen = new Set(cur.map((p) => p.name || p.id));
        return [...cur, ...more.filter((p) => !seen.has(p.name || p.id))];
      });
    } catch {
      /* transient; the next end-reach retries */
    } finally {
      fetching.current = false;
    }
  };

  // Optimistic vote/save, reverted on failure — same behavior as the web app.
  const patchPost = (name: string, patch: Partial<Post>) =>
    setPosts((cur) => cur.map((p) => (p.name === name ? { ...p, ...patch } : p)));

  const vote = async (post: Post, dir: 1 | -1) => {
    const current = post.likes === true ? 1 : post.likes === false ? -1 : 0;
    const target = current === dir ? 0 : dir;
    patchPost(post.name, { likes: target === 1 ? true : target === -1 ? false : null });
    try {
      await api('/api/vote', { id: post.name, dir: target });
    } catch (err: any) {
      patchPost(post.name, { likes: post.likes });
      notify('Vote failed', String(err?.message || err));
    }
  };

  const toggleSave = async (post: Post) => {
    patchPost(post.name, { saved: !post.saved });
    try {
      await api('/api/save', { id: post.name, save: !post.saved });
    } catch (err: any) {
      patchPost(post.name, { saved: post.saved });
      notify('Save failed', String(err?.message || err));
    }
  };

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setActiveIndex(first.index);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <View style={{ height: listHeight }}>
        {item.kind === 'video' ? (
          <VideoPost post={item} active={index === activeIndex} muted={muted} />
        ) : item.kind === 'gallery' ? (
          <GalleryPost post={item} />
        ) : item.kind === 'image' ? (
          <ImagePost post={item} />
        ) : (
          <TextPost post={item} />
        )}

        {/* Per-post overlay: meta bottom-left, actions bottom-right. */}
        <View style={[styles.meta, { paddingBottom: insets.bottom + 18 }]} pointerEvents="box-none">
          <View style={styles.metaText} pointerEvents="none">
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {[item.subreddit, item.author && `u/${item.author}`, item.nsfw && 'NSFW']
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <View style={styles.rail}>
            <RailButton
              label="▲"
              active={item.likes === true}
              activeColor={colors.upvote}
              onPress={() => vote(item, 1)}
            />
            <RailButton
              label="▼"
              active={item.likes === false}
              activeColor={colors.downvote}
              onPress={() => vote(item, -1)}
            />
            <RailButton
              label="★"
              active={item.saved}
              activeColor={colors.save}
              onPress={() => toggleSave(item)}
            />
            {item.kind === 'video' ? (
              <RailButton label={muted ? '🔇' : '🔊'} onPress={() => setMuted((m) => !m)} />
            ) : null}
          </View>
        </View>
      </View>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listHeight, activeIndex, muted, insets.bottom]
  );

  return (
    <View style={styles.root} onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}>
      {ready && listHeight > 0 && (
        <FlatList
          ref={listRef}
          data={posts}
          renderItem={renderItem}
          keyExtractor={(p) => p.name || p.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: listHeight, offset: listHeight * i, index: i })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          windowSize={5}
          ListEmptyComponent={
            <View style={[styles.empty, { height: listHeight }]}>
              {loading ? (
                <ActivityIndicator size="large" color={colors.accent} />
              ) : error ? (
                <Text style={styles.error}>{error}</Text>
              ) : (
                <>
                  <Text style={styles.emptyTitle}>redditview</Text>
                  <Text style={styles.hint}>
                    Enter a feed above — r/pics, u/name/submitted, saved — or leave it empty for your
                    home feed (needs the cookie in settings).
                  </Text>
                </>
              )}
            </View>
          }
        />
      )}

      {/* Top bar: feed input + settings. */}
      <View style={[styles.topbar, { paddingTop: insets.top + 8 }]}>
        <TextInput
          style={styles.feedInput}
          value={feedInput}
          onChangeText={setFeedInput}
          onSubmitEditing={() => loadFeed(feedInput.trim())}
          placeholder="r/pics · saved · empty = home"
          placeholderTextColor={colors.hint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          testID="feed-input"
        />
        <Pressable style={styles.goBtn} onPress={() => loadFeed(feedInput.trim())} testID="go-btn">
          <Text style={styles.goBtnText}>Go</Text>
        </Pressable>
        <Pressable style={styles.gearBtn} onPress={() => setSettingsOpen(true)} testID="gear-btn">
          <Text style={styles.gearText}>⚙︎</Text>
        </Pressable>
      </View>

      {settingsOpen && (
        <SettingsModal
          visible
          onClose={(changed) => {
            setSettingsOpen(false);
            if (changed) loadFeed(feedInput.trim() || getSettings().feed);
          }}
        />
      )}
      <StatusBar style="light" />
    </View>
  );
}

function RailButton({
  label,
  active,
  activeColor,
  onPress,
}: {
  label: string;
  active?: boolean;
  activeColor?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.railBtn} onPress={onPress} hitSlop={8}>
      <Text style={[styles.railIcon, active && activeColor ? { color: activeColor } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Feed />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topbar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  feedInput: {
    flex: 1,
    backgroundColor: colors.chrome,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    color: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 14,
  },
  goBtn: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  goBtnText: { color: '#fff', fontWeight: '700' },
  gearBtn: {
    backgroundColor: colors.chrome,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearText: { color: colors.text, fontSize: 18 },
  meta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 16,
    paddingRight: 8,
  },
  metaText: { flex: 1, marginRight: 8 },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },
  sub: { color: colors.textDim, fontSize: 12, marginTop: 3 },
  rail: { alignItems: 'center', gap: 4 },
  railBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railIcon: {
    color: colors.text,
    fontSize: 24,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { color: colors.accent, fontSize: 28, fontWeight: '800', marginBottom: 10 },
  hint: { color: colors.hint, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  error: { color: colors.error, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
