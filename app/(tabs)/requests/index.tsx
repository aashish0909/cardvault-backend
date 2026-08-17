import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authenticateOnce } from '../../../lib/auth';
import { maskedPan } from '../../../lib/cards';
import { decryptJSON } from '../../../lib/crypto';
import {
  CardRow,
  CardSecrets,
  clearRequestHistory,
  getCard,
  listCards,
  listPeers,
  listRequests,
  PeerRow,
  RequestKind,
  RequestRow,
  setRequestStatus as setRequestStatusLocal,
} from '../../../lib/db';
import {
  approveDetails,
  approveOtp,
  cancelRequest,
  denyRequest,
  revokeRequest,
  useInboxStore,
} from '../../../lib/relay';
import { colors } from '../../../lib/theme';
import { formatCountdown } from '../../../lib/useCountdown';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
  expired: 'Expired',
  revoked: 'Revoked',
};

type KindFilter = 'all' | RequestKind;

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'details', label: 'Details' },
  { value: 'otp', label: 'OTP' },
];

// Reveal windows the card owner can choose from when approving a details
// request. The selected window is sent to the borrower inside the approve
// blob (expiresAt), so both sides enforce the same deadline.
const WINDOW_OPTIONS = [
  { label: '2 minutes', ms: 2 * 60 * 1000 },
  { label: '5 minutes', ms: 5 * 60 * 1000 },
  { label: '10 minutes', ms: 10 * 60 * 1000 },
  { label: '15 minutes', ms: 15 * 60 * 1000 },
];

export default function RequestsScreen() {
  const insets = useSafeAreaInsets();
  const inboxEvent = useInboxStore((s) => s.eventId);

  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [peers, setPeers] = useState<Record<string, PeerRow>>({});
  const [cards, setCards] = useState<Record<string, CardRow>>({});
  const [otpInputFor, setOtpInputFor] = useState<string | null>(null);
  const [otpDraft, setOtpDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [approving, setApproving] = useState<{
    req: RequestRow;
    secrets: CardSecrets;
  } | null>(null);

  const reload = useCallback(() => {
    listRequests().then(setRequests);
    listPeers().then((rows) => {
      setPeers(Object.fromEntries(rows.map((p) => [p.id, p])));
    });
    listCards().then((rows) => {
      setCards(Object.fromEntries(rows.map((c) => [c.id, c])));
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  useEffect(() => {
    reload();
  }, [inboxEvent, reload]);

  // Tick once a second while any reveal window is still open, so owners see
  // the same live countdown the borrower sees.
  const hasOpenWindow = requests.some(
    (r) =>
      r.status === 'approved' &&
      r.windowExpiresAt != null &&
      r.windowExpiresAt > now
  );
  useEffect(() => {
    if (!hasOpenWindow) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasOpenWindow]);

  const onApprove = async (req: RequestRow) => {
    if (busy) return;
    const ok = await authenticateOnce('Approve this request?');
    if (!ok) return;
    setBusy(req.id);
    try {
      if (req.kind === 'details') {
        const card = await getCard(req.cardId);
        if (!card) {
          Alert.alert('Card missing', 'This card no longer exists on your device.');
          return;
        }
        const secrets = await decryptJSON<CardSecrets>(card.payload);
        // Ask the owner how long the borrower may see the details.
        setApproving({ req, secrets });
      } else {
        setOtpInputFor(req.id); // wait for the OTP from SMS before relaying
        return;
      }
    } catch (e) {
      Alert.alert('Could not approve', String(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const confirmApprove = async (windowMs: number) => {
    if (!approving || busy) return;
    setBusy(approving.req.id);
    try {
      await approveDetails(approving.req, approving.secrets, windowMs);
      setApproving(null);
    } catch (e) {
      Alert.alert('Could not approve', String(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const onSendOtp = async (req: RequestRow) => {
    const otp = otpDraft[req.id]?.trim();
    if (!otp || busy) return;
    setBusy(req.id);
    try {
      await approveOtp(req, otp);
      setOtpInputFor(null);
      setOtpDraft((d) => ({ ...d, [req.id]: '' }));
    } catch (e) {
      Alert.alert('Could not send OTP', String(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const onDeny = async (req: RequestRow) => {
    if (busy) return;
    setBusy(req.id);
    try {
      await denyRequest(req);
    } catch {
      // Offline: still mark denied locally; sync happens on a future request.
      setRequestStatusLocal(req.id, 'denied');
    } finally {
      setBusy(null);
      reload();
    }
  };

  const onCancel = async (req: RequestRow) => {
    if (busy) return;
    setBusy(req.id);
    try {
      await cancelRequest(req);
    } catch {
      setRequestStatusLocal(req.id, 'cancelled');
    } finally {
      setBusy(null);
      reload();
    }
  };

  const onClearHistory = () => {
    if (history.length === 0 || busy) return;
    Alert.alert(
      'Clear request history',
      'Delete all resolved requests (approved, denied, cancelled, expired) from this phone? Pending requests stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            const ok = await authenticateOnce('Clear request history?');
            if (!ok) return;
            try {
              await clearRequestHistory();
            } finally {
              reload();
            }
          },
        },
      ]
    );
  };

  const onRevoke = async (req: RequestRow) => {
    if (busy) return;
    Alert.alert(
      'Revoke access',
      'The revealed card details or OTP will disappear from the other device immediately.',
      [
        { text: 'Keep open', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setBusy(req.id);
            try {
              await revokeRequest(req);
            } catch {
              setRequestStatusLocal(req.id, 'revoked');
            } finally {
              setBusy(null);
              reload();
            }
          },
        },
      ]
    );
  };

  const pendingIn = requests.filter(
    (r) => r.direction === 'in' && r.status === 'pending'
  );
  const pendingOut = requests.filter(
    (r) => r.direction === 'out' && r.status === 'pending'
  );
  const history = requests.filter((r) => r.status !== 'pending');

  const matchesKind = (r: RequestRow) =>
    kindFilter === 'all' || r.kind === kindFilter;
  const filteredPendingIn = pendingIn.filter(matchesKind);
  const filteredPendingOut = pendingOut.filter(matchesKind);
  const filteredHistory = history.filter(matchesKind);

  const cardLabel = (r: RequestRow) => {
    const card = cards[r.cardId];
    return card ? `${card.nickname} ·${maskedPan(card.last4)}` : 'Card';
  };

  const renderActions = (req: RequestRow) => {
    if (req.direction === 'in' && req.status === 'approved') {
      return (
        <Pressable
          style={styles.revokeButton}
          onPress={() => onRevoke(req)}
          disabled={busy !== null}
        >
          <Text style={styles.revokeText}>
            {busy === req.id ? '...' : 'Revoke access'}
          </Text>
        </Pressable>
      );
    }
    if (req.direction === 'out') {
      if (req.status === 'pending') {
        return (
          <Pressable
            style={styles.cancelButton}
            onPress={() => onCancel(req)}
            disabled={busy !== null}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        );
      }
      return null; // approved outgoing requests need no action
    }
    if (req.kind === 'details') {
      return (
        <View style={styles.rowActions}>
          <Pressable
            style={styles.approveButton}
            onPress={() => onApprove(req)}
            disabled={busy !== null}
          >
            <Text style={styles.approveText}>
              {busy === req.id ? '...' : 'Approve'}
            </Text>
          </Pressable>
          <Pressable
            style={styles.denyButton}
            onPress={() => onDeny(req)}
            disabled={busy !== null}
          >
            <Text style={styles.denyText}>Deny</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.rowActions}>
        <Pressable
          style={styles.approveButton}
          onPress={() => onApprove(req)}
          disabled={busy !== null}
        >
          <Text style={styles.approveText}>Approve</Text>
        </Pressable>
        <Pressable
          style={styles.denyButton}
          onPress={() => onDeny(req)}
          disabled={busy !== null}
        >
          <Text style={styles.denyText}>Deny</Text>
        </Pressable>
      </View>
    );
  };

  const renderRow = (req: RequestRow) => {
    const peerName = peers[req.peerId]?.name ?? 'Friend';
    const isOtpEntryOpen = otpInputFor === req.id;
    const windowMs =
      req.status === 'approved' && req.windowExpiresAt != null
        ? req.windowExpiresAt - now
        : 0;
    const windowOpen = windowMs > 0;
    return (
      <View style={styles.row}>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.rowTitle}>
              {req.direction === 'in' ? peerName : 'You'} ·{' '}
              {req.kind === 'details' ? 'card details' : 'OTP'}
            </Text>
            <Text style={styles.rowStatus}>{STATUS_LABELS[req.status]}</Text>
          </View>
          <Text style={styles.rowCard}>{cardLabel(req)}</Text>
          {req.kind === 'otp' && req.amount && (
            <Text style={styles.rowAmount}>
              ₹{req.amount}
              {req.merchant ? ` at ${req.merchant}` : ''}
            </Text>
          )}
          {req.status === 'approved' && req.windowExpiresAt != null && (
            <Text style={windowOpen ? styles.windowTimer : styles.windowExpired}>
              {windowOpen
                ? `${req.kind === 'details' ? 'Details' : 'OTP'} visible for ${formatCountdown(windowMs)}`
                : 'Reveal window closed'}
            </Text>
          )}
          <Text style={styles.rowTime}>
            {new Date(req.createdAt).toLocaleString()}
          </Text>
          {req.status === 'pending' && renderActions(req)}
          {req.status === 'approved' && renderActions(req)}
          {isOtpEntryOpen && req.status === 'pending' && (
            <View style={styles.otpBox}>
              <Text style={styles.otpLabel}>
                Enter the OTP from the SMS on your phone:
              </Text>
              <TextInput
                style={styles.otpInput}
                value={otpDraft[req.id] ?? ''}
                onChangeText={(v) =>
                  setOtpDraft((d) => ({ ...d, [req.id]: v.replace(/\D/g, '') }))
                }
                placeholder="123456"
                placeholderTextColor={colors.muted}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={8}
                autoFocus
              />
              <View style={styles.rowActions}>
                <Pressable
                  style={styles.approveButton}
                  onPress={() => onSendOtp(req)}
                  disabled={busy !== null || !otpDraft[req.id]?.trim()}
                >
                  <Text style={styles.approveText}>Send OTP</Text>
                </Pressable>
                <Pressable
                  style={styles.denyButton}
                  onPress={() => {
                    setOtpInputFor(null);
                    onDeny(req);
                  }}
                  disabled={busy !== null}
                >
                  <Text style={styles.denyText}>Deny</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Requests</Text>
      </View>
      <View style={styles.filterRow}>
        {KIND_FILTERS.map((f) => {
          const active = kindFilter === f.value;
          return (
            <Pressable
              key={f.value}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setKindFilter(f.value)}
              hitSlop={4}
            >
              <Text
                style={[
                  styles.filterChipText,
                  active && styles.filterChipTextActive,
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FlatList
        data={[
          ...filteredPendingIn.map((r) => ({ ...r, section: 'in' as const })),
          ...filteredPendingOut.map((r) => ({ ...r, section: 'out' as const })),
          ...filteredHistory.map((r) => ({ ...r, section: 'history' as const })),
        ]}
        keyExtractor={(item) => `${item.section}-${item.id}`}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            {filteredPendingIn.length > 0 && (
              <Text style={styles.sectionTitle}>Needs your approval</Text>
            )}
            {filteredPendingOut.length > 0 && (
              <Text style={styles.sectionTitle}>Waiting for them</Text>
            )}
            {filteredHistory.length > 0 && (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>History</Text>
                <Pressable
                  onPress={onClearHistory}
                  hitSlop={8}
                  disabled={busy !== null}
                >
                  <Text style={styles.clearHistoryText}>Clear</Text>
                </Pressable>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {kindFilter === 'all'
                ? 'No requests yet'
                : `No ${kindFilter} requests`}
            </Text>
            <Text style={styles.emptyText}>
              {kindFilter === 'all'
                ? 'When a friend asks for your card details or an OTP, it shows up here for you to approve or deny.'
                : 'Nothing matches this filter yet. Try another type or switch back to All.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => renderRow(item)}
      />

      {approving && (
        <Modal
          transparent
          animationType="fade"
          visible
          onRequestClose={() => setApproving(null)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                How long can they see the details?
              </Text>
              <Text style={styles.modalSub}>
                {peers[approving.req.peerId]?.name ?? 'Your friend'} will see
                the full card details on their phone for the window you pick.
                They can also request an OTP separately at any time.
              </Text>
              {WINDOW_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.ms}
                  style={styles.modalOption}
                  onPress={() => confirmApprove(opt.ms)}
                  disabled={busy !== null}
                >
                  <Text style={styles.modalOptionText}>{opt.label}</Text>
                </Pressable>
              ))}
              <Pressable
                style={styles.modalCancel}
                onPress={() => setApproving(null)}
                disabled={busy !== null}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
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
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  filterChip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterChipText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clearHistoryText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  rowBody: {
    flex: 1,
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  rowStatus: {
    color: colors.muted,
    fontSize: 12,
  },
  rowCard: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4,
  },
  rowAmount: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  windowTimer: {
    color: colors.success,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  windowExpired: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 6,
  },
  rowTime: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 4,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  approveButton: {
    backgroundColor: colors.success,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  approveText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  denyButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  denyText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  cancelButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  cancelText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  revokeButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  revokeText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  otpBox: {
    marginTop: 12,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 12,
  },
  otpLabel: {
    color: colors.muted,
    fontSize: 12,
  },
  otpInput: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 18,
    letterSpacing: 4,
    marginTop: 8,
    textAlign: 'center',
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  modalSub: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    marginBottom: 14,
  },
  modalOption: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalOptionText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
  },
});
