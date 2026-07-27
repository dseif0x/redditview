import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, Comment, CommentsPage, Post, qs } from '../api';
import { showSheet } from './sheets';
import { colors } from '../theme';

// Comments bottom sheet, ported from the web app: full tree, sortable, tap
// a comment to collapse/expand its subtree.

const COMMENT_SORTS = [
  { text: 'Best', value: 'confidence' },
  { text: 'Top', value: 'top' },
  { text: 'New', value: 'new' },
  { text: 'Controversial', value: 'controversial' },
  { text: 'Old', value: 'old' },
  { text: 'Q&A', value: 'qa' },
];

function timeAgo(utcSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - utcSeconds);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 31536000) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / 31536000) + 'y';
}

function countReplies(c: Comment): number {
  let n = c.replies?.length || 0;
  for (const r of c.replies || []) n += countReplies(r);
  return n;
}

function CommentNode({ comment, depth }: { comment: Comment; depth: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const kidCount = countReplies(comment) + (comment.moreCount || 0);
  return (
    <Pressable
      onPress={() => setCollapsed((c) => !c)}
      style={[styles.comment, depth > 0 && styles.nested]}
    >
      <View style={styles.head}>
        <Text style={[styles.author, comment.isSubmitter && styles.op]}>{comment.author}</Text>
        {comment.isSubmitter ? <Text style={styles.badge}>OP</Text> : null}
        {comment.distinguished === 'moderator' ? <Text style={styles.badge}>MOD</Text> : null}
        {comment.stickied ? <Text style={styles.badge}>📌</Text> : null}
        <Text style={styles.meta}>
          {comment.scoreHidden ? '·' : `${comment.score} pts`} · {timeAgo(comment.createdUtc)}
        </Text>
        {collapsed ? <Text style={styles.collapsedHint}>[+{kidCount + 1}]</Text> : null}
      </View>
      {!collapsed ? (
        <>
          <Text style={styles.body}>{comment.body}</Text>
          {(comment.replies || []).map((r) => (
            <CommentNode key={r.id} comment={r} depth={depth + 1} />
          ))}
          {comment.moreCount ? (
            <Text style={styles.more}>
              … {comment.moreCount} more repl{comment.moreCount === 1 ? 'y' : 'ies'} on reddit
            </Text>
          ) : null}
        </>
      ) : null}
    </Pressable>
  );
}

export function CommentsSheet({ post, onClose }: { post: Post; onClose: () => void }) {
  const [sort, setSort] = useState('confidence');
  const [data, setData] = useState<CommentsPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api<CommentsPage>(`/api/comments?${qs({ id: post.id, sort })}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(String(err?.message || err)));
    return () => {
      cancelled = true;
    };
  }, [post, sort]);

  const pickCommentSort = async () => {
    const v = await showSheet('Sort comments', COMMENT_SORTS, sort);
    if (v !== undefined && v !== sort) setSort(v);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {post.numComments ? `Comments (${post.numComments})` : 'Comments'}
            </Text>
            <Pressable style={styles.sortBtn} onPress={pickCommentSort}>
              <Text style={styles.sortText}>
                {COMMENT_SORTS.find((s) => s.value === sort)?.text} ▾
              </Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} testID="comments-close">
              <Ionicons name="close-outline" size={24} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {error ? (
              <Text style={styles.error}>Failed to load comments: {error}</Text>
            ) : !data ? (
              <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 40 }} />
            ) : data.comments.length === 0 ? (
              <Text style={styles.empty}>No comments yet.</Text>
            ) : (
              <>
                {data.comments.map((c) => (
                  <CommentNode key={c.id} comment={c} depth={0} />
                ))}
                {data.more ? (
                  <Text style={styles.more}>… {data.more} more comments on reddit</Text>
                ) : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    height: '78%',
    backgroundColor: '#14141c',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: '#33333f',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: '#26262f',
  },
  title: { color: colors.text, fontWeight: '600', fontSize: 15, flex: 1 },
  sortBtn: {
    borderWidth: 1,
    borderColor: '#33333f',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.bg,
  },
  sortText: { color: colors.text, fontSize: 13 },
  close: { color: colors.text, fontSize: 18, padding: 4 },
  list: { flex: 1 },
  listContent: { padding: 14, paddingBottom: 40 },
  comment: { paddingTop: 7 },
  nested: { marginLeft: 13, paddingLeft: 9, borderLeftWidth: 2, borderColor: '#2c2c38' },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' },
  author: { fontWeight: '600', color: '#d7d7e0', fontSize: 13 },
  op: { color: '#ff8b66' },
  badge: {
    fontSize: 10,
    color: '#7fb4ff',
    borderWidth: 1,
    borderColor: '#33445f',
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  meta: { color: colors.hint, fontSize: 12 },
  collapsedHint: { color: colors.hint, fontSize: 12 },
  body: { color: '#d9d9e2', fontSize: 14.5, lineHeight: 21, marginTop: 2, marginBottom: 4 },
  more: { color: '#71717f', fontSize: 13, fontStyle: 'italic', paddingVertical: 5 },
  empty: { color: colors.hint, textAlign: 'center', marginTop: 40 },
  error: { color: colors.error, margin: 20, textAlign: 'center' },
});
