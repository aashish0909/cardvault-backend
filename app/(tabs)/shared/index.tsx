import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardLogo } from '../../../components/CardLogo';
import { maskedPan } from '../../../lib/cards';
import {
  listPeers,
  listSharedCards,
  setSharedCardLabel,
  setSharedCardStatus,
  SharedCardRow,
} from '../../../lib/db';
import { useInboxStore } from '../../../lib/relay';
import { colors } from '../../../lib/theme';

export default function SharedCardsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<SharedCardRow[]>([]);
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inboxEvent = useInboxStore((s) => s.eventId);

  const reload = useCallback(() => {
    listSharedCards().then(setCards);
    listPeers().then((peers) => {
      const map: Record<string, string> = {};
      for (const p of peers) map[p.id] = p.name;
      setPeerNames(map);
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  // Live refresh: reload whenever the inbox handles a new blob.
  useEffect(() => {
    reload();
  }, [inboxEvent, reload]);

  const onAccept = async (card: SharedCardRow) => {
    await setSharedCardStatus(card.id, 'accepted');
    reload();
  };

  const startEdit = (card: SharedCardRow) => {
    setDraft(card.label ?? card.nickname);
    setEditingId(card.id);
  };

  const saveLabel = async (card: SharedCardRow) => {
    const value = draft.trim().slice(0, 40);
    await setSharedCardLabel(card.id, value || null);
    setEditingId(null);
    setDraft('');
    setCards((prev) =>
      prev.map((c) => (c.id === card.id ? { ...c, label: value || null } : c))
    );
  };

  const sharerCount = new Set(cards.map((c) => c.peerId)).size;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Shared with me</Text>
        {cards.length > 0 && (
          <Text style={styles.subtitle}>
            {cards.length} card{cards.length === 1 ? '' : 's'} · {sharerCount} friend
            {sharerCount === 1 ? '' : 's'}
          </Text>
        )}
      </View>

      <FlatList
        data={cards}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Nothing shared yet</Text>
            <Text style={styles.emptyText}>
              When a friend shares a card with you, it appears here - masked,
              until they approve a request to reveal it.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const sharer = peerNames[item.peerId] ?? 'A friend';
          const initial = (sharer[0] ?? '?').toUpperCase();
          return (
            <View style={styles.row}>
              <Pressable
                style={[styles.cardFace, { backgroundColor: item.color }]}
                onPress={() => router.push(`/shared/${item.id}`)}
              >
                <View style={styles.cardFaceTop}>
                  <CardLogo network={item.network} width={36} />
                  {item.status === 'new' && (
                    <View style={styles.newBadge}>
                      <Text style={styles.newBadgeText}>NEW</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.cardPan}>{maskedPan(item.last4)}</Text>
                {editingId === item.id ? (
                  <TextInput
                    style={styles.cardLabelInput}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={item.nickname}
                    placeholderTextColor="rgba(255,255,255,0.5)"
                    maxLength={40}
                    autoFocus
                    onSubmitEditing={() => saveLabel(item)}
                  />
                ) : (
                  <Text style={styles.cardNickname}>
                    {item.label ?? item.nickname}
                  </Text>
                )}
              </Pressable>
              <View style={styles.rowFooter}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.sharedBy}>
                    Shared by <Text style={styles.sharedByName}>{sharer}</Text>
                  </Text>
                  <View style={styles.rowSub}>
                    <CardLogo network={item.network} width={20} />
                    <Text style={styles.rowSubText}>•••• {item.last4}</Text>
                  </View>
                </View>
                {item.status === 'new' ? (
                  <Pressable
                    style={styles.acceptButton}
                    onPress={() => onAccept(item)}
                  >
                    <Text style={styles.acceptText}>Accept</Text>
                  </Pressable>
                ) : editingId === item.id ? (
                  <View style={styles.editActions}>
                    <Pressable
                      onPress={() => saveLabel(item)}
                      hitSlop={8}
                      style={styles.editDone}
                    >
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color={colors.success}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setEditingId(null);
                        setDraft('');
                      }}
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={18} color={colors.muted} />
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.editActions}>
                    <Pressable onPress={() => startEdit(item)} hitSlop={8}>
                      <Ionicons
                        name="pencil"
                        size={16}
                        color={colors.muted}
                      />
                    </Pressable>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={colors.muted}
                    />
                  </View>
                )}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 2,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 14,
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  cardFace: {
    borderRadius: 14,
    padding: 18,
    minHeight: 130,
    justifyContent: 'space-between',
  },
  cardFaceTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  newBadge: {
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  newBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  cardPan: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  cardNickname: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '500',
  },
  cardLabelInput: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.6)',
    paddingVertical: 0,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  editDone: {
    paddingVertical: 2,
  },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  rowMeta: {
    flex: 1,
  },
  sharedBy: {
    color: colors.muted,
    fontSize: 13,
  },
  sharedByName: {
    color: colors.text,
    fontWeight: '600',
  },
  rowSub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 1,
  },
  rowSubText: {
    color: colors.muted,
    fontSize: 12,
  },
  acceptButton: {
    backgroundColor: colors.success,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  acceptText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 300,
    lineHeight: 20,
  },
});
