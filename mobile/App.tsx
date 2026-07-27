import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewToken,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { VideoPlayer } from 'expo-video';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, FeedPage, mediaUrl, Post, qs } from './src/api';
import { CommentsSheet } from './src/components/CommentsSheet';
import { PinchZoom } from './src/components/PinchZoom';
import { SeekBar } from './src/components/SeekBar';
import { SheetHost, pickSort, showSheet } from './src/components/sheets';
import { toast, ToastHost } from './src/components/Toast';
import { voteBurst, VoteBurstHost } from './src/components/VoteBurst';
import { GalleryHandle, GalleryPost, ImagePost, TextPost, VideoPost } from './src/PostViews';
import { initPWA } from './src/pwa';
import { SettingsModal } from './src/SettingsModal';
import { isSeen, loadSeen, markSeen } from './src/seen';
import { getSettings, loadSettings, Resume, saveSettings, Settings } from './src/settings';
import { applySort, sortLabel } from './src/sort';
import { colors } from './src/theme';

function kindEnabled(post: Post, st: Settings): boolean {
  switch (post.kind) {
    case 'video':
      return st.showVideos;
    case 'text':
      return st.showText;
    default: // image + gallery
      return st.showImages;
  }
}

function Feed() {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<Settings>(getSettings());
  const refreshPrefs = () => setPrefs({ ...getSettings() });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const [feedInput, setFeedInput] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedTitle, setExpandedTitle] = useState(false);
  const [galleryPage, setGalleryPage] = useState<{ name: string; page: number }>({ name: '', page: 0 });
  const [historyLen, setHistoryLen] = useState(0);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Refs mirroring state for use inside stable callbacks.
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = settingsOpen || commentsPost !== null;

  const listRef = useRef<FlatList<Post>>(null);
  const afterRef = useRef<string | null>(null);
  const exhaustedRef = useRef(false);
  const fetching = useRef(false);
  const feedSeq = useRef(0);
  const loadedNames = useRef(new Set<string>());
  const resumeExempt = useRef<string | null>(null);
  const feedStarted = useRef(false);
  const history = useRef<Resume[]>([]);
  const pendingAdvance = useRef(false);
  const bookkeepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const galleryRefs = useRef(new Map<string, GalleryHandle | null>());
  const currentPlayer = useRef<VideoPlayer | null>(null);
  const pausedBySheet = useRef(false);

  // ---------------------------------------------------------------------
  // Progress bar + autoscroll countdown (images/galleries/text). Videos
  // drive the bar from timeUpdate events and advance via playToEnd.
  // ---------------------------------------------------------------------
  const progressAnim = useRef(new Animated.Value(0)).current;
  const scrubbing = useRef(false);
  const timer = useRef<{ running: boolean; remaining: number; total: number } | null>(null);

  const clearTimer = () => {
    timer.current = null;
    progressAnim.stopAnimation();
    progressAnim.setValue(0);
  };

  const runTimer = () => {
    const t = timer.current;
    if (!t) return;
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: t.remaining,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && timer.current === t) onTimerDone();
    });
  };

  const startTimer = () => {
    clearTimer();
    if (!getSettings().autoscroll) return;
    const total = getSettings().imageSeconds * 1000;
    timer.current = { running: true, remaining: total, total };
    runTimer();
  };

  const pauseTimer = () => {
    const t = timer.current;
    if (!t || !t.running) return;
    t.running = false;
    progressAnim.stopAnimation((v) => {
      t.remaining = Math.max(0, t.total * (1 - v));
    });
  };

  const resumeTimer = () => {
    const t = timer.current;
    if (!t || t.running) return;
    t.running = true;
    runTimer();
  };

  const onTimerDone = () => {
    const post = postsRef.current[activeIndexRef.current];
    // Galleries show every image for the configured duration before moving on.
    if (post?.kind === 'gallery') {
      const h = galleryRefs.current.get(post.name);
      if (h?.step(1)) return; // onPage restarts the timer
    }
    nextSlide();
  };

  // ---------------------------------------------------------------------
  // Feed loading: bounded attempts loop with kind filters, skip-seen (the
  // resume target is exempt) and dedupe against reddit's shifting cursor
  // pagination — ported from the web app.
  // ---------------------------------------------------------------------
  const fetchBatch = async (): Promise<Post[]> => {
    const st = getSettings();
    for (let attempts = 0; attempts < 5; attempts++) {
      if (exhaustedRef.current) break;
      const params: Record<string, string> = { path: applySort(st.feed, st.sort) };
      if (afterRef.current) params.after = afterRef.current;
      const data = await api<FeedPage>('/api/feed?' + qs(params));
      const cursorUsed = afterRef.current || '';
      const added = data.posts.filter(
        (p) =>
          kindEnabled(p, st) &&
          !loadedNames.current.has(p.name || p.id) &&
          (!st.skipSeen || !isSeen(p.id) || p.name === resumeExempt.current)
      );
      for (const p of added) {
        p._cursor = cursorUsed;
        loadedNames.current.add(p.name || p.id);
      }
      afterRef.current = data.after || null;
      if (!afterRef.current) exhaustedRef.current = true;
      if (added.length > 0 || exhaustedRef.current) return added;
    }
    return [];
  };

  const loadFeed = async (path: string, resume: Resume | null = null) => {
    const seq = ++feedSeq.current;
    saveSettings({ feed: path });
    refreshPrefs();
    feedStarted.current = true;
    afterRef.current = resume?.cursor || null;
    exhaustedRef.current = false;
    loadedNames.current = new Set();
    resumeExempt.current = resume?.name ?? null;
    pendingAdvance.current = false;
    clearTimer();
    setPosts([]);
    setError('');
    setLoading(true);
    setActiveIndex(0);
    try {
      const first = await fetchBatch();
      if (seq !== feedSeq.current) return;
      setPosts(first);
      if (first.length === 0) {
        setError('No viewable posts in this feed.');
        return;
      }
      // When resuming, jump straight to the remembered post if it's there.
      const at = resume ? first.findIndex((p) => p.name === resume.name) : -1;
      if (at > 0) {
        setActiveIndex(at);
        setTimeout(() => listRef.current?.scrollToIndex({ index: at, animated: false }), 50);
      }
    } catch (err: any) {
      if (seq === feedSeq.current) setError(String(err?.message || err));
    } finally {
      if (seq === feedSeq.current) setLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (fetching.current || exhaustedRef.current || !feedStarted.current) return;
    const seq = feedSeq.current;
    fetching.current = true;
    try {
      const added = await fetchBatch();
      if (seq !== feedSeq.current) return;
      if (added.length) setPosts((cur) => [...cur, ...added]);
      else if (exhaustedRef.current && pendingAdvance.current) toast('End of feed');
    } catch (err: any) {
      toast('Failed to load more: ' + String(err?.message || err));
    } finally {
      fetching.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A deferred advance (autoscroll hit the end while the next page loads).
  useEffect(() => {
    if (pendingAdvance.current && posts.length > activeIndexRef.current + 1) {
      pendingAdvance.current = false;
      listRef.current?.scrollToIndex({ index: activeIndexRef.current + 1, animated: true });
    }
  }, [posts.length]);

  const nextSlide = () => {
    const i = activeIndexRef.current;
    if (i + 1 < postsRef.current.length) {
      listRef.current?.scrollToIndex({ index: i + 1, animated: true });
    } else if (exhaustedRef.current) {
      toast('End of feed');
    } else {
      pendingAdvance.current = true;
      loadMore();
    }
  };

  // ---------------------------------------------------------------------
  // Feed history: subreddit/author jumps push the position being left so
  // the back button restores both the feed and where you were in it.
  // ---------------------------------------------------------------------
  const currentPosition = (): Resume => {
    const st = getSettings();
    const p = postsRef.current[activeIndexRef.current];
    return { path: st.feed, sort: st.sort, cursor: p?._cursor || '', name: p?.name || '' };
  };

  const goToFeed = (path: string) => {
    if (feedStarted.current) {
      history.current.push(currentPosition());
      setHistoryLen(history.current.length);
    }
    setFeedInput(path);
    loadFeed(path);
  };

  const goBack = () => {
    const prev = history.current.pop();
    setHistoryLen(history.current.length);
    if (!prev) return;
    saveSettings({ sort: prev.sort });
    setFeedInput(prev.path);
    loadFeed(prev.path, prev.name ? prev : null);
  };

  // ---------------------------------------------------------------------
  // Startup: settings + seen store, then resume the last session.
  // ---------------------------------------------------------------------
  useEffect(() => {
    initPWA();
    Promise.all([loadSettings(), loadSeen()]).then(([s]) => {
      refreshPrefs();
      setReady(true);
      const r = s.resume;
      if (r && r.name) {
        setFeedInput(r.path);
        saveSettings({ sort: r.sort });
        loadFeed(r.path, r);
      } else if (Platform.OS !== 'web' && !s.serverUrl) {
        setSettingsOpen(true);
      } else if (Platform.OS !== 'web' || s.feed || s.serverUrl || s.accounts.length) {
        setFeedInput(s.feed);
        loadFeed(s.feed);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------
  // Slide activation: seen-tracking, resume bookkeeping, timers, prefetch.
  // ---------------------------------------------------------------------
  const activePost: Post | undefined = posts[activeIndex];
  const activeName = activePost?.name;

  useEffect(() => {
    if (!activeName || !activePost) return;
    setExpandedTitle(false);
    progressAnim.setValue(0);
    if (activePost.kind === 'video') clearTimer();
    else startTimer();
    markSeen(activePost.id);
    if (bookkeepTimer.current) clearTimeout(bookkeepTimer.current);
    bookkeepTimer.current = setTimeout(() => {
      const st = getSettings();
      const p = postsRef.current[activeIndexRef.current];
      if (p) saveSettings({ resume: { path: st.feed, sort: st.sort, cursor: p._cursor || '', name: p.name } });
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName]);

  useEffect(() => {
    for (let i = activeIndex + 1; i <= Math.min(activeIndex + 2, posts.length - 1); i++) {
      const p = posts[i];
      if ((p.kind === 'image' || p.kind === 'gallery') && p.images?.[0]) {
        Image.prefetch(mediaUrl(p.images[0])).catch(() => {});
      }
    }
    if (posts.length && activeIndex >= posts.length - 5) loadMore();
  }, [activeIndex, posts, loadMore]);

  // Hold playback + countdown while a sheet is open (comments/settings).
  const sheetOpen = settingsOpen || commentsPost !== null;
  useEffect(() => {
    if (sheetOpen) {
      pauseTimer();
      if (currentPlayer.current?.playing) {
        currentPlayer.current.pause();
        pausedBySheet.current = true;
      }
    } else {
      resumeTimer();
      if (pausedBySheet.current) {
        pausedBySheet.current = false;
        currentPlayer.current?.play();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------
  const patchPost = (name: string, patch: Partial<Post>) =>
    setPosts((cur) => cur.map((p) => (p.name === name ? { ...p, ...patch } : p)));

  const requireCookie = (): boolean => {
    if (!getSettings().accounts[getSettings().activeAccount]?.cookie.trim()) {
      toast('Set your reddit cookie in settings to vote/save');
      return false;
    }
    return true;
  };

  const vote = async (post: Post, dir: 1 | -1) => {
    if (!post.name || !requireCookie()) return;
    const cur = post.likes === true ? 1 : post.likes === false ? -1 : 0;
    const target = cur === dir ? 0 : dir; // voting the same way again clears it
    patchPost(post.name, { likes: target === 1 ? true : target === -1 ? false : null });
    try {
      await api('/api/vote', { id: post.name, dir: target });
    } catch (err: any) {
      patchPost(post.name, { likes: post.likes });
      toast('Vote failed: ' + String(err?.message || err));
    }
  };

  const toggleSave = async (post: Post) => {
    if (!post.name || !requireCookie()) return;
    patchPost(post.name, { saved: !post.saved });
    try {
      await api('/api/save', { id: post.name, save: !post.saved });
      toast(post.saved ? 'Unsaved' : 'Saved', 1200);
    } catch (err: any) {
      patchPost(post.name, { saved: post.saved });
      toast('Save failed: ' + String(err?.message || err));
    }
  };

  // Like Instagram/TikTok: double-tap only upvotes, never removes the vote.
  const doubleTapUpvote = (post: Post) => (x: number, y: number) => {
    voteBurst(x, y);
    if (post.likes !== true) vote(post, 1);
  };

  const toggleAutoscroll = () => {
    const on = !getSettings().autoscroll;
    saveSettings({ autoscroll: on });
    refreshPrefs();
    const post = postsRef.current[activeIndexRef.current];
    if (post && post.kind !== 'video') {
      if (on) startTimer();
      else clearTimer();
    }
    toast(on ? 'Autoscroll on' : 'Autoscroll off', 1000);
  };

  const toggleMute = () => {
    saveSettings({ muted: !getSettings().muted });
    refreshPrefs();
  };

  const toggleFill = () => {
    saveSettings({ fillScreen: !getSettings().fillScreen });
    refreshPrefs();
  };

  const openSortPicker = async () => {
    const sort = await pickSort(getSettings().sort);
    if (sort === undefined) return;
    saveSettings({ sort });
    refreshPrefs();
    if (feedStarted.current) loadFeed(feedInput.trim() || getSettings().feed);
  };

  // Bookmarks: star the current feed (with its sort); reopen from the list.
  const bookmarkIndex = () =>
    getSettings().bookmarks.findIndex((b) => b.path === feedInput.trim());

  const toggleBookmark = () => {
    const st = getSettings();
    const i = bookmarkIndex();
    const bookmarks = [...st.bookmarks];
    if (i >= 0) {
      bookmarks.splice(i, 1);
      toast('Bookmark removed', 1200);
    } else {
      bookmarks.push({ path: feedInput.trim(), sort: st.sort });
      toast('Feed bookmarked', 1200);
    }
    saveSettings({ bookmarks });
    refreshPrefs();
  };

  const openBookmarks = async () => {
    const bookmarks = getSettings().bookmarks;
    if (!bookmarks.length) return;
    const v = await showSheet(
      'Saved feeds',
      bookmarks.map((b, i) => ({
        text: (b.path || '(home)') + (b.sort ? ` · ${b.sort.replace(':', ' ')}` : ''),
        value: String(i),
      }))
    );
    if (v === undefined) return;
    const b = bookmarks[Number(v)];
    if (!b) return;
    saveSettings({ sort: b.sort || '' });
    refreshPrefs();
    goToFeed(b.path);
  };

  // Seek (video only): live preview while dragging, commit on release.
  const onScrub = (frac: number) => {
    scrubbing.current = true;
    progressAnim.setValue(frac);
  };
  const onScrubEnd = (frac: number) => {
    scrubbing.current = false;
    const p = currentPlayer.current;
    if (p && p.duration > 0) p.currentTime = frac * p.duration;
  };

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setActiveIndex(first.index);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  // Re-anchor the list when the feed axis flips in settings.
  useEffect(() => {
    if (postsRef.current.length) {
      setTimeout(
        () => listRef.current?.scrollToIndex({ index: activeIndexRef.current, animated: false }),
        50
      );
    }
  }, [prefs.vertical]);

  const horizontal = !prefs.vertical;
  const extent = horizontal ? size.w : size.h;

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => {
      const isActive = index === activeIndex;
      const singleTapTimer = () => {
        // Tapping a non-video slide pauses/resumes the autoscroll countdown.
        if (!getSettings().autoscroll) return;
        if (timer.current?.running) pauseTimer();
        else resumeTimer();
      };
      return (
        <View style={{ width: size.w, height: size.h }}>
          <PinchZoom onPinchActive={(a) => setScrollEnabled(!a)}>
            {item.kind === 'video' ? (
              <VideoPost
                post={item}
                active={isActive && !sheetOpen}
                muted={prefs.muted}
                autoscroll={prefs.autoscroll}
                fill={prefs.fillScreen}
                showPauseIcon={prefs.showPauseIcon}
                onEnded={() => {
                  if (getSettings().autoscroll && !sheetOpenRef.current) nextSlide();
                }}
                onProgress={(frac) => {
                  if (!scrubbing.current) progressAnim.setValue(frac);
                }}
                registerPlayer={(p) => (currentPlayer.current = p)}
                onDoubleTap={doubleTapUpvote(item)}
              />
            ) : item.kind === 'gallery' ? (
              <GalleryPost
                ref={(h) => {
                  galleryRefs.current.set(item.name, h);
                }}
                post={item}
                width={size.w}
                height={size.h}
                feedVertical={prefs.vertical}
                fill={prefs.fillScreen}
                onPage={(page) => {
                  setGalleryPage({ name: item.name, page });
                  if (isActive) startTimer(); // each image gets the full duration
                }}
                onSingleTap={singleTapTimer}
                onDoubleTap={doubleTapUpvote(item)}
              />
            ) : item.kind === 'image' ? (
              <ImagePost
                post={item}
                fill={prefs.fillScreen}
                onSingleTap={singleTapTimer}
                onDoubleTap={doubleTapUpvote(item)}
              />
            ) : (
              <TextPost post={item} onSingleTap={singleTapTimer} onDoubleTap={doubleTapUpvote(item)} />
            )}
          </PinchZoom>

          {/* Per-post overlay: meta bottom-left, actions bottom-right. */}
          <View style={[styles.meta, { paddingBottom: insets.bottom + 20 }]} pointerEvents="box-none">
            <View style={styles.metaText} pointerEvents="box-none">
              <Pressable onPress={() => isActive && setExpandedTitle((e) => !e)}>
                <Text style={styles.title} numberOfLines={isActive && expandedTitle ? undefined : 2}>
                  {item.title}
                </Text>
              </Pressable>
              <View style={styles.subRow} pointerEvents="box-none">
                {item.subreddit ? (
                  <Pressable onPress={() => goToFeed(item.subreddit)}>
                    <Text style={styles.feedLink}>{item.subreddit}</Text>
                  </Pressable>
                ) : null}
                {item.author ? (
                  <Pressable onPress={() => goToFeed(`user/${item.author}/submitted`)}>
                    <Text style={styles.feedLink}>u/{item.author}</Text>
                  </Pressable>
                ) : null}
                {item.nsfw ? <Text style={styles.sub}>NSFW</Text> : null}
                {item.kind === 'gallery' && item.images ? (
                  <Text style={styles.sub}>
                    {(galleryPage.name === item.name ? galleryPage.page : 0) + 1}/{item.images.length}
                  </Text>
                ) : null}
                <Pressable onPress={() => Linking.openURL(item.permalink).catch(() => {})}>
                  <Text style={styles.openLink}>open ↗</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.rail}>
              <RailButton label="▲" active={item.likes === true} activeColor={colors.upvote} onPress={() => vote(item, 1)} />
              <RailButton label="▼" active={item.likes === false} activeColor={colors.downvote} onPress={() => vote(item, -1)} />
              <RailButton label="★" active={item.saved} activeColor={colors.save} onPress={() => toggleSave(item)} />
              <RailButton
                label="💬"
                sub={item.numComments ? String(item.numComments) : undefined}
                onPress={() => setCommentsPost(item)}
              />
              {item.kind === 'video' ? (
                <RailButton label={prefs.muted ? '🔇' : '🔊'} onPress={toggleMute} />
              ) : null}
            </View>
          </View>
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [size, activeIndex, expandedTitle, galleryPage, sheetOpen, prefs, insets.bottom]
  );

  const marked = prefs.bookmarks.some((b) => b.path === feedInput.trim());
  const seekableNow = activePost?.kind === 'video' && !sheetOpen;

  return (
    <View style={styles.root} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {ready && size.h > 0 && (
        <FlatList
          ref={listRef}
          data={posts}
          renderItem={renderItem}
          keyExtractor={(p) => p.name || p.id}
          horizontal={horizontal}
          pagingEnabled
          scrollEnabled={scrollEnabled}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: extent, offset: extent * i, index: i })}
          onScrollToIndexFailed={({ index }) => {
            listRef.current?.scrollToOffset({ offset: extent * index, animated: false });
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          windowSize={5}
          ListEmptyComponent={
            <View style={[styles.empty, { width: size.w, height: size.h }]}>
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

      <SeekBar
        progress={progressAnim}
        seekable={!!seekableNow}
        pos={prefs.barPos}
        invert={prefs.barInvert}
        bottomInset={insets.bottom}
        topInset={insets.top}
        onScrub={onScrub}
        onScrubEnd={onScrubEnd}
      />

      {/* Top bar: feed input row + tools row. */}
      <View style={[styles.topbar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topRow}>
          {historyLen > 0 ? (
            <Pressable style={styles.roundBtn} onPress={goBack} testID="back-btn">
              <Text style={styles.roundBtnText}>‹</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={styles.feedInput}
            value={feedInput}
            onChangeText={setFeedInput}
            onSubmitEditing={() => goToFeed(feedInput.trim())}
            placeholder="r/pics · saved · empty = home"
            placeholderTextColor={colors.hint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            testID="feed-input"
          />
          <Pressable style={styles.goBtn} onPress={() => goToFeed(feedInput.trim())} testID="go-btn">
            <Text style={styles.goBtnText}>Go</Text>
          </Pressable>
          <Pressable style={styles.roundBtn} onPress={() => setSettingsOpen(true)} testID="gear-btn">
            <Text style={styles.roundBtnText}>⚙︎</Text>
          </Pressable>
        </View>
        <View style={styles.toolsRow}>
          {prefs.bookmarks.length ? (
            <Pressable style={styles.pill} onPress={openBookmarks} testID="bookmarks-btn">
              <Text style={styles.pillText}>★ Feeds</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.pillIcon} onPress={toggleBookmark} testID="bm-btn">
            <Text style={[styles.pillText, marked && { color: colors.save }]}>{marked ? '★' : '☆'}</Text>
          </Pressable>
          <Pressable style={[styles.pill, { flex: 1 }]} onPress={openSortPicker} testID="sort-btn">
            <Text style={[styles.pillText, prefs.sort ? { color: colors.accent } : null]} numberOfLines={1}>
              {sortLabel(prefs.sort)} ▾
            </Text>
          </Pressable>
          <Pressable style={styles.pillIcon} onPress={toggleFill} testID="fill-btn">
            <Text style={[styles.pillText, prefs.fillScreen && { color: colors.accent }]}>⛶</Text>
          </Pressable>
          <Pressable style={styles.pillIcon} onPress={toggleAutoscroll} testID="autoscroll-btn">
            <Text style={[styles.pillText, prefs.autoscroll && { color: colors.accent }]}>
              {prefs.autoscroll ? '❚❚' : '▶'}
            </Text>
          </Pressable>
        </View>
      </View>

      {commentsPost ? <CommentsSheet post={commentsPost} onClose={() => setCommentsPost(null)} /> : null}
      {settingsOpen ? (
        <SettingsModal
          onClose={(result) => {
            setSettingsOpen(false);
            if (result.changed) {
              refreshPrefs();
              setFeedInput(getSettings().feed);
              // Reload the active feed — or start it for the first time
              // (first-launch configuration ends here).
              if (result.reloadFeed) loadFeed(getSettings().feed);
            }
          }}
        />
      ) : null}

      <ToastHost />
      <SheetHost />
      <VoteBurstHost />
      <StatusBar style="light" />
    </View>
  );
}

function RailButton({
  label,
  sub,
  active,
  activeColor,
  onPress,
}: {
  label: string;
  sub?: string;
  active?: boolean;
  activeColor?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.railBtn} onPress={onPress} hitSlop={6}>
      <Text style={[styles.railIcon, active && activeColor ? { color: activeColor } : null]}>{label}</Text>
      {sub ? <Text style={styles.railSub}>{sub}</Text> : null}
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
  topbar: { position: 'absolute', top: 0, left: 0, right: 0, gap: 7, paddingHorizontal: 12, paddingBottom: 10 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolsRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
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
  goBtn: { backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  goBtnText: { color: '#fff', fontWeight: '700' },
  roundBtn: {
    backgroundColor: colors.chrome,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnText: { color: colors.text, fontSize: 18 },
  pill: {
    backgroundColor: colors.chrome,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
    alignItems: 'center',
  },
  pillIcon: {
    backgroundColor: colors.chrome,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    width: 34,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { color: colors.text, fontSize: 13 },
  meta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 16,
    paddingRight: 6,
  },
  metaText: { flex: 1, marginRight: 8 },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  sub: { color: colors.textDim, fontSize: 12 },
  feedLink: {
    color: '#b5b5c2',
    fontSize: 12,
    borderBottomWidth: 1,
    borderStyle: 'dotted',
    borderColor: '#55555f',
  },
  openLink: { color: '#ff8b66', fontSize: 12 },
  rail: { alignItems: 'center', gap: 2 },
  railBtn: { width: 44, minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  railIcon: { color: colors.text, fontSize: 23, textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 4 },
  railSub: { color: colors.textDim, fontSize: 10, marginTop: -2 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { color: colors.accent, fontSize: 28, fontWeight: '800', marginBottom: 10 },
  hint: { color: colors.hint, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  error: { color: colors.error, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
