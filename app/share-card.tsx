import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardLogo } from '../components/CardLogo';
import { CardRow, getCard, listPeers, PeerRow, addShare, removeShare, listShares, ShareRow } from '../lib/db';
import { sendBlob } from '../lib/relay';
import { colors } from '../lib/theme';

export default function ShareCardScreen() {
  const { id, ids } = useLocalSearchParams<{ id?: string; ids?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const cardIds = useMemo(() => {
    if (ids) {
      return ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (id) return [id];
    return [];
  }, [id, ids]);

  const [cards, setCards] = useState<CardRow[]>([]);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [shares, setShares] = useState<ShareRow[]>([]);

  useEffect(() => {
    Promise.all(cardIds.map(getCard)).then((rows) =>
      setCards(rows.filter((r): r is CardRow => r !== null))
    );
  }, [cardIds]);

  useEffect(() => {
    listPeers().then(setPeers);
  }, []);

  const reloadShares = useCallback(() => {
    Promise.all(cardIds.map((cid) => listShares(cid))).then((groups) =>
      setShares(groups.flat())
    );
  }, [cardIds]);

  useEffect(reloadShares, [reloadShares]);

  const sharedIdsForPeer = (peerId: string) =>
    new Set(shares.filter((s) => s.peerId === peerId).map((s) => s.cardId));

  const sharedCountForPeer = (peerId: string) => {
    const sharedIds = sharedIdsForPeer(peerId);
    return cards.filter((c) => sharedIds.has(c.id)).length;
  };

  const onShare = async (peer: PeerRow) => {
    const sharedIds = sharedIdsForPeer(peer.id);
    for (const card of cards) {
      if (sharedIds.has(card.id)) continue;
      await addShare(card.id, peer.id);
      sendBlob(peer.id, 'card-share', {
        cardId: card.id,
        nickname: card.nickname,
        network: card.network,
        last4: card.last4,
        color: card.color,
      }).catch(() => {});
    }
    reloadShares();
  };

  const onUnshare = (peer: PeerRow) => {
    const message =
      cards.length === 1
        ? `"${cards[0].nickname}" will be removed from ${peer.name}'s device immediately, and any open reveal windows will be revoked.`
        : `These ${cards.length} cards will be removed from ${peer.name}'s device immediately, and any open reveal windows will be revoked.`;
    Alert.alert('Stop sharing', message, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop sharing',
          style: 'destructive',
          onPress: async () => {
            for (const card of cards) {
              await removeShare(card.id, peer.id);
              sendBlob(peer.id, 'card-unshare', { cardId: card.id }).catch(() => {});
            }
            reloadShares();
          },
        },
      ]
    );
  };

  const onToggle = (peer: PeerRow) => {
    if (cards.length > 0 && sharedCountForPeer(peer.id) === cards.length) {
      onUnshare(peer);
    } else {
      onShare(peer);
    }
  };

  const paired = peers.filter((p) => p.status === 'paired');

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>
          {cards.length > 1 ? `Share ${cards.length} cards` : 'Share card'}
        </Text>
      </View>

      {cards.length > 0 && (
        <View style={styles.cardStack}>
          {cards.map((card) => (
            <View key={card.id} style={[styles.cardTile, { backgroundColor: card.color }]}>
              <Text style={styles.cardNickname}>{card.nickname}</Text>
              <View style={styles.cardMetaRow}>
                <CardLogo network={card.network} width={26} />
                <Text style={styles.cardMeta}>•••• {card.last4}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      <FlatList
        data={paired}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <Text style={styles.sectionLabel}>Choose friends</Text>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              Pair with a friend first (Friends tab) before sharing a card.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const sharedCount = sharedCountForPeer(item.id);
          const allShared = cards.length > 0 && sharedCount === cards.length;
          return (
            <Pressable
              style={[styles.peerRow, allShared && styles.peerRowShared]}
              onPress={() => onToggle(item)}
            >
              <View style={styles.peerInfo}>
                <Text style={styles.peerName}>{item.name}</Text>
                {cards.length > 0 && (
                  <Text style={styles.sharedHint}>
                    {allShared
                      ? `Shared with ${item.name}`
                      : sharedCount > 0
                        ? `${sharedCount} of ${cards.length} shared`
                        : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} will be shared`}
                  </Text>
                )}
              </View>
              {allShared ? (
                <View style={styles.stopButton}>
                  <Text style={styles.stopText}>Stop sharing</Text>
                </View>
              ) : (
                <Text style={styles.shareText}>Share</Text>
              )}
            </Pressable>
          );
        }}
      />

      <Text style={styles.note}>
        Friends only see the masked card until you approve a request. They never
        receive the card number, expiry or CVV ahead of time.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 20,
  },
  backText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  cardStack: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
  },
  cardTile: {
    borderRadius: 14,
    padding: 18,
  },
  cardNickname: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  cardMeta: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
  },
  listContent: {
    gap: 10,
  },
  sectionLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  peerRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  peerInfo: {
    flex: 1,
    marginRight: 12,
  },
  peerRowShared: {
    borderColor: colors.success,
  },
  peerName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  sharedHint: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  shareText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  stopButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  stopText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyState: {
    paddingVertical: 24,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  note: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 18,
  },
});
