import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardLogo } from '../../../components/CardLogo';
import { maskedPan } from '../../../lib/cards';
import {
  deletePeer,
  listPeers,
  listSharedCards,
  PeerRow,
  removeSharedCardsByPeer,
  removeSharesByPeer,
  setPeerStatus,
  SharedCardRow,
} from '../../../lib/db';
import { getIdentity, pairingFingerprint } from '../../../lib/identity';
import { sendBlob, useInboxStore } from '../../../lib/relay';
import { colors } from '../../../lib/theme';

export default function FriendsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [sharedCards, setSharedCards] = useState<SharedCardRow[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [myPub, setMyPub] = useState('');
  const inboxEvent = useInboxStore((s) => s.eventId);

  useEffect(() => {
    void getIdentity().then((id) => setMyPub(id.pubHex));
  }, []);

  const reload = useCallback(() => {
    listPeers().then(setPeers);
    listSharedCards().then(setSharedCards);
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

  const onAccept = async (peer: PeerRow) => {
    await setPeerStatus(peer.id, 'paired');
    sendBlob(peer.id, 'pair-accept', {}).catch(() => {});
    reload();
  };

  const onDecline = async (peer: PeerRow) => {
    // Notify the other side BEFORE dropping the local record - sendBlob needs
    // the peer's public key to seal the message.
    await sendBlob(peer.id, 'pair-decline', {}).catch(() => {});
    await deletePeer(peer.id);
    await removeSharedCardsByPeer(peer.id);
    reload();
  };

  const onRemove = async (peer: PeerRow) => {
    // Send the unfriend notice BEFORE deleting locally - sendBlob needs the
    // peer's public key to seal it.
    await sendBlob(peer.id, 'pair-decline', {}).catch(() => {});
    await deletePeer(peer.id);
    await removeSharesByPeer(peer.id);
    await removeSharedCardsByPeer(peer.id);
    reload();
  };

  const cardsByPeer = useMemo(() => {
    const map: Record<string, SharedCardRow[]> = {};
    for (const card of sharedCards) {
      (map[card.peerId] ??= []).push(card);
    }
    return map;
  }, [sharedCards]);

  const incoming = peers.filter((p) => p.direction === 'in' && p.status === 'pending');
  const outgoing = peers.filter((p) => p.direction === 'out' && p.status === 'pending');
  const paired = peers.filter((p) => p.status === 'paired');

  const toggleExpanded = (peerId: string) =>
    setExpanded((prev) => ({ ...prev, [peerId]: !prev[peerId] }));

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Friends</Text>
        <View style={styles.headerButtons}>
          <Pressable
            style={styles.headerButton}
            onPress={() => router.push('/pair/scan')}
          >
            <Text style={styles.headerButtonText}>Scan QR</Text>
          </Pressable>
          <Pressable
            style={styles.headerButton}
            onPress={() => router.push('/pair/my-qr')}
          >
            <Text style={styles.headerButtonText}>My QR</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={[
          ...incoming.map((p) => ({ ...p, section: 'incoming' as const })),
          ...outgoing.map((p) => ({ ...p, section: 'outgoing' as const })),
          ...paired.map((p) => ({ ...p, section: 'paired' as const })),
        ]}
        keyExtractor={(item) => `${item.section}-${item.id}`}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            {incoming.length > 0 && (
              <Text style={styles.sectionTitle}>Pair requests</Text>
            )}
            {outgoing.length > 0 && (
              <Text style={styles.sectionTitle}>Waiting for them to accept</Text>
            )}
            {paired.length > 0 && (
              <Text style={styles.sectionTitle}>
                Friends · tap a friend to see their available cards
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No friends yet</Text>
            <Text style={styles.emptyText}>
              Meet in person (or use the manual code) to pair: one of you scans
              the other's QR. The public keys are exchanged on-device - nothing
              goes through the cloud. Cards a friend shares with you will show
              up under their name.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.section === 'paired') {
            const available = cardsByPeer[item.id] ?? [];
            const isOpen = !!expanded[item.id];
            const initial = (item.name[0] ?? '?').toUpperCase();
            return (
              <View style={styles.peerBlock}>
                <Pressable
                  style={styles.peerRow}
                  onPress={() => toggleExpanded(item.id)}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initial}</Text>
                  </View>
                  <View style={styles.peerInfo}>
                    <Text style={styles.peerName}>{item.name}</Text>
                    <Text style={styles.peerStatus}>
                      {available.length === 0
                        ? 'No shared cards yet'
                        : `${available.length} card${available.length === 1 ? '' : 's'} available`}
                    </Text>
                  </View>
                  <Ionicons
                    name={isOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.muted}
                  />
                  <Pressable
                    style={styles.removeButton}
                    onPress={() => {
                      Alert.alert(
                        'Remove friend',
                        `Unpair from ${item.name}? Cards shared with them will stop working on their side.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => onRemove(item),
                          },
                        ]
                      );
                    }}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </Pressable>
                {isOpen && (
                  <View style={styles.expanded}>
                    {available.length === 0 ? (
                      <Text style={styles.expandedEmpty}>
                        Nothing shared yet. Ask {item.name} to share a card with
                        you from their Cards tab.
                      </Text>
                    ) : (
                      available.map((card) => (
                        <Pressable
                          key={card.id}
                          style={styles.sharedCardRow}
                          onPress={() => router.push(`/shared/${card.id}`)}
                        >
                          <CardLogo network={card.network} width={22} />
                          <View style={styles.sharedCardInfo}>
                            <Text
                              style={styles.sharedCardName}
                              numberOfLines={1}
                            >
                              {card.label ?? card.nickname}
                            </Text>
                            <Text style={styles.sharedCardMeta}>
                              {maskedPan(card.last4)}
                            </Text>
                          </View>
                          <Text style={styles.requestText}>Request</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                )}
              </View>
            );
          }
          return (
            <View style={styles.peerRow}>
              <View style={styles.peerInfo}>
                <Text style={styles.peerName}>{item.name}</Text>
                <Text style={styles.peerStatus}>
                  {item.section === 'outgoing'
                    ? 'Waiting for them to accept'
                    : 'Wants to pair with you'}
                </Text>
                {!!myPub && (
                  <FingerprintLine pubHex={item.publicKey} myPub={myPub} outgoing={item.section === 'outgoing'} />
                )}
              </View>
              {item.section === 'incoming' ? (
                <View style={styles.rowActions}>
                  <Pressable style={styles.acceptButton} onPress={() => onAccept(item)}>
                    <Text style={styles.acceptText}>Accept</Text>
                  </Pressable>
                  <Pressable style={styles.declineButton} onPress={() => onDecline(item)}>
                    <Text style={styles.declineText}>Decline</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable style={styles.removeButton} onPress={() => onDecline(item)}>
                  <Text style={styles.declineText}>Remove</Text>
                </Pressable>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

function FingerprintLine({
  pubHex,
  myPub,
  outgoing,
}: {
  pubHex: string;
  myPub: string;
  outgoing: boolean;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    void pairingFingerprint(myPub, pubHex).then(setValue);
  }, [myPub, pubHex]);
  if (!value) return null;
  return (
    <>
      <Text style={styles.fingerprintValue}>{value}</Text>
      <Text style={styles.fingerprint}>
        {outgoing
          ? 'They should see this same number on the pairing request.'
          : 'This must match the number on their screen before you accept.'}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  headerButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 12,
  },
  sectionTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 4,
  },
  peerBlock: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  peerRow: {
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  peerStatus: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  fingerprintValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 8,
  },
  fingerprint: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 4,
    letterSpacing: 0.4,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 12,
  },
  acceptButton: {
    backgroundColor: colors.success,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  acceptText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  declineButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  declineText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  removeButton: {
    paddingVertical: 4,
  },
  removeText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  expanded: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
  },
  expandedEmpty: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  sharedCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  sharedCardInfo: {
    flex: 1,
  },
  sharedCardName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  sharedCardMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 1,
  },
  requestText: {
    color: colors.accent,
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
