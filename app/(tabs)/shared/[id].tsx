import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardLogo } from '../../../components/CardLogo';
import { formatPan, maskedPan } from '../../../lib/cards';
import {
  getPeer,
  getSharedCard,
  listRequests,
  setSharedCardLabel,
  SharedCardRow,
  RequestRow,
} from '../../../lib/db';
import { requestDetails, requestOtp, useInboxStore } from '../../../lib/relay';
import { useRevealStore } from '../../../lib/reveal';
import { useCountdown, formatCountdown } from '../../../lib/useCountdown';
import { colors } from '../../../lib/theme';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
  expired: 'Expired',
  revoked: 'Revoked',
};

export default function SharedCardDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [card, setCard] = useState<SharedCardRow | null>(null);
  const [peerName, setPeerName] = useState('');
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const inboxEvent = useInboxStore((s) => s.eventId);

  const details = useRevealStore((s) => (card ? s.details[card.ownerCardId] : undefined));
  const otpStore = useRevealStore((s) => s.otp);
  const otpRequest = requests.find((r) => r.kind === 'otp' && r.status === 'approved');
  const otp = otpRequest ? otpStore[otpRequest.id] : undefined;
  const pendingDetailsOut = requests.some(
    (r) => r.kind === 'details' && r.direction === 'out' && r.status === 'pending'
  );
  const pendingOtpOut = requests.some(
    (r) => r.kind === 'otp' && r.direction === 'out' && r.status === 'pending'
  );
  // The most recent OTP request. If its window already closed (or it was
  // revoked/denied), the borrower can request another one.
  const lastOtp = requests.find((r) => r.kind === 'otp');
  const lastOtpExpired =
    lastOtp != null &&
    lastOtp.status === 'approved' &&
    lastOtp.windowExpiresAt != null &&
    lastOtp.windowExpiresAt <= Date.now();

  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [otpFormOpen, setOtpFormOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoCopied = useRef<string | null>(null);

  const loadRequests = useCallback(() => {
    if (!card) return;
    listRequests().then((rows) => {
      const filtered = rows.filter((r) => r.cardId === card.ownerCardId);
      // Only re-render when something actually changed (status, window,
      // amount, ...) so the screen doesn't churn every 5 seconds.
      setRequests((prev) => {
        if (
          prev.length === filtered.length &&
          prev.every(
            (r, i) =>
              r.id === filtered[i].id &&
              r.status === filtered[i].status &&
              r.windowExpiresAt === filtered[i].windowExpiresAt &&
              r.amount === filtered[i].amount
          )
        ) {
          return prev;
        }
        return filtered;
      });
    });
  }, [card]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const row = await getSharedCard(id);
      setCard(row ?? null);
      if (row) {
        const peer = await getPeer(row.peerId);
        setPeerName(peer?.name ?? 'Friend');
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!card) return;
    loadRequests();
    const timer = setInterval(loadRequests, 5000);
    return () => {
      clearInterval(timer);
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    };
  }, [card, loadRequests]);

  // Live refresh: reload as soon as the inbox handles a blob (long-poll makes
  // this near-instant), instead of waiting for the fallback interval.
  useEffect(() => {
    loadRequests();
  }, [inboxEvent, loadRequests]);

  const onCopy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopiedField(label);
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      const current = await Clipboard.getStringAsync();
      if (current === value) await Clipboard.setStringAsync('');
      setCopiedField(null);
    }, 60 * 1000);
  };

  // Auto-copy each newly received OTP so it can be pasted right away; the
  // standard 60s clipboard wipe still applies.
  useEffect(() => {
    if (!otp || lastAutoCopied.current === otp.otp) return;
    lastAutoCopied.current = otp.otp;
    void onCopy('otp', otp.otp);
  }, [otp]);

  const onRequestDetails = async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await requestDetails(card.peerId, card.ownerCardId);
      loadRequests();
    } catch (e) {
      Alert.alert('Could not send request', String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRequestOtp = async () => {
    if (!card || busy) return;
    const amt = amount.trim();
    if (!amt) {
      Alert.alert('Enter an amount');
      return;
    }
    setBusy(true);
    try {
      await requestOtp(card.peerId, card.ownerCardId, amt, merchant.trim());
      setOtpFormOpen(false);
      setAmount('');
      setMerchant('');
      loadRequests();
    } catch (e) {
      Alert.alert('Could not send request', String(e));
    } finally {
      setBusy(false);
    }
  };

  // Re-request with the previous amount/merchant in one tap, no form.
  const onRequestAnotherOtp = async () => {
    if (!card || busy) return;
    const amt = lastOtp?.amount ?? '';
    if (!amt) {
      setOtpFormOpen((v) => !v);
      return;
    }
    setBusy(true);
    try {
      await requestOtp(card.peerId, card.ownerCardId, amt, lastOtp?.merchant ?? '');
      setOtpFormOpen(false);
      loadRequests();
    } catch (e) {
      Alert.alert('Could not send request', String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEditLabel = () => {
    if (!card) return;
    setLabelDraft(card.label ?? card.nickname);
    setEditingLabel(true);
  };

  const saveLabel = async () => {
    if (!card) return;
    const value = labelDraft.trim().slice(0, 40);
    await setSharedCardLabel(card.id, value || null);
    setCard({ ...card, label: value || null });
    setEditingLabel(false);
  };

  if (!card) {
    return <View style={styles.container} />;
  }

  const displayStatus = (r: RequestRow) => {
    if (
      r.status === 'approved' &&
      r.windowExpiresAt != null &&
      r.windowExpiresAt <= Date.now()
    ) {
      return 'Expired';
    }
    return STATUS_LABELS[r.status];
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </View>

      <View style={[styles.cardVisual, { backgroundColor: card.color }]}>
        <CardLogo network={card.network} width={48} />
        <Text style={styles.cardPan}>
          {details ? formatPan(details.secrets.pan) : maskedPan(card.last4)}
        </Text>
        {editingLabel ? (
          <TextInput
            style={styles.cardLabelInput}
            value={labelDraft}
            onChangeText={setLabelDraft}
            placeholder={card.nickname}
            placeholderTextColor="rgba(255,255,255,0.5)"
            maxLength={40}
            autoFocus
            onSubmitEditing={saveLabel}
          />
        ) : (
          <View style={styles.cardNameRow}>
            <Text style={styles.cardNickname}>
              {card.label ?? card.nickname}
            </Text>
            <Pressable onPress={startEditLabel} hitSlop={10}>
              <Ionicons
                name="pencil"
                size={15}
                color="rgba(255,255,255,0.85)"
              />
            </Pressable>
          </View>
        )}
      </View>

      {editingLabel && (
        <View style={styles.renameActions}>
          <Text style={styles.renameHint}>
            Only you see this name - {peerName}'s card is unchanged.
          </Text>
          <View style={styles.renameButtons}>
            <Pressable
              style={[styles.renameButton, styles.renameCancelButton]}
              onPress={() => setEditingLabel(false)}
            >
              <Text style={styles.renameCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.renameButton, styles.renameSaveButton]}
              onPress={saveLabel}
            >
              <Text style={styles.renameSaveText}>Save name</Text>
            </Pressable>
          </View>
        </View>
      )}

      {!editingLabel && card.label && card.label !== card.nickname && (
        <Text style={styles.renameNote}>
          Renamed by you · original: {card.nickname}
        </Text>
      )}

      <View style={styles.infoBox}>
        <Text style={styles.infoLabel}>Shared by</Text>
        <Text style={styles.infoValue}>{peerName}</Text>
      </View>

      {details ? (
        <>
          <View style={styles.windowBanner}>
            <Text style={styles.windowTitle}>
              Details revealed · auto-hides in{' '}
              <RevealCountdown expiresAt={details.expiresAt} />
            </Text>
            <Text style={styles.windowText}>
              {peerName} approved your request. The details below will vanish
              when the window closes.
            </Text>
          </View>
          <View style={styles.detailsBox}>
            <DetailRow
              label="Card number"
              value={formatPan(details.secrets.pan)}
              copied={copiedField === 'pan'}
              onCopy={() => onCopy('pan', details.secrets.pan)}
            />
            <DetailRow
              label="Expiry"
              value={details.secrets.expiry}
              copied={copiedField === 'expiry'}
              onCopy={() => onCopy('expiry', details.secrets.expiry)}
            />
            <DetailRow
              label="CVV"
              value={details.secrets.cvv}
              copied={copiedField === 'cvv'}
              onCopy={() => onCopy('cvv', details.secrets.cvv)}
            />
            <DetailRow
              label="Card holder"
              value={details.secrets.holderName}
              copied={copiedField === 'holder'}
              onCopy={() => onCopy('holder', details.secrets.holderName)}
            />
          </View>
          <Text style={styles.clipboardNote}>
            Copied values are wiped from the clipboard after 60 seconds.
          </Text>
        </>
      ) : pendingDetailsOut ? (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingText}>
            Details request sent - waiting for {peerName} to approve it.
          </Text>
        </View>
      ) : (
        <Pressable
          style={[styles.primaryButton, busy && styles.disabled]}
          onPress={onRequestDetails}
          disabled={busy}
        >
          <Text style={styles.primaryButtonText}>Request card details</Text>
        </Pressable>
      )}

      {otp ? (
        <View style={styles.otpReveal}>
          <Text style={styles.otpRevealTitle}>
            OTP <RevealCountdown expiresAt={otp.expiresAt} prefix="expires in" />
          </Text>
          <Text style={styles.otpValue}>{otp.otp}</Text>
          <Pressable
            style={styles.otpCopyButton}
            onPress={() => onCopy('otp', otp.otp)}
          >
            <Text style={styles.otpCopyText}>
              {copiedField === 'otp' ? 'Copied ✓' : 'Copy OTP'}
            </Text>
          </Pressable>
          {pendingOtpOut ? (
            <Text style={styles.otpAnotherNote}>
              Another OTP request is pending approval.
            </Text>
          ) : (
            <Pressable
              style={[styles.otpAnotherButton, busy && styles.disabled]}
              onPress={onRequestAnotherOtp}
              disabled={busy}
            >
              <Text style={styles.otpAnotherText}>Request another OTP</Text>
            </Pressable>
          )}
        </View>
      ) : pendingOtpOut ? (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingText}>
            OTP request sent - waiting for {peerName} to approve it.
          </Text>
        </View>
      ) : lastOtpExpired ? (
        <>
          <View style={styles.pendingBox}>
            <Text style={styles.pendingText}>
              The previous OTP expired. Request a new one below.
            </Text>
          </View>
          <Pressable
            style={[styles.primaryButton, busy && styles.disabled]}
            onPress={onRequestAnotherOtp}
            disabled={busy}
          >
            <Text style={styles.primaryButtonText}>Request another OTP</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          style={[styles.secondaryButton, busy && styles.disabled]}
          onPress={() => setOtpFormOpen((v) => !v)}
          disabled={busy}
        >
          <Text style={styles.secondaryButtonText}>Request OTP</Text>
        </Pressable>
      )}

      {otpFormOpen && !pendingOtpOut && (
        <View style={styles.formBox}>
          <Text style={styles.label}>Amount (₹)</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="1499"
            placeholderTextColor={colors.muted}
            keyboardType="decimal-pad"
          />
          <Text style={styles.label}>Merchant (optional)</Text>
          <TextInput
            style={styles.input}
            value={merchant}
            onChangeText={setMerchant}
            placeholder="Swiggy"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
          />
          <Pressable
            style={[styles.primaryButton, (busy || !amount.trim()) && styles.disabled]}
            onPress={onRequestOtp}
            disabled={busy || !amount.trim()}
          >
            <Text style={styles.primaryButtonText}>Send OTP request</Text>
          </Pressable>
        </View>
      )}

      {requests.length > 0 && (
        <View style={styles.historyBox}>
          <Text style={styles.historyTitle}>Recent requests</Text>
          {requests.slice(0, 6).map((r) => (
            <View style={styles.historyRow} key={r.id}>
              <Text style={styles.historyLabel}>
                {r.kind === 'details' ? 'Card details' : `OTP${r.amount ? ` · ₹${r.amount}` : ''}`}
              </Text>
              <View style={styles.historyRight}>
                <Text style={styles.historyStatus}>{displayStatus(r)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

/** Countdown that only re-renders its own text each second, so the rest of
 * the screen (ScrollView content) isn't re-created on every tick. */
function RevealCountdown({
  expiresAt,
  prefix,
}: {
  expiresAt: number | null | undefined;
  prefix?: string;
}) {
  const { remainingMs, expired } = useCountdown(expiresAt);
  if (expired) return <>{prefix ? `${prefix} ` : ''}expired</>;
  return <>{prefix ? `${prefix} ` : ''}{formatCountdown(remainingMs)}</>;
}

function DetailRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailText}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
      <Pressable onPress={onCopy} hitSlop={8}>
        <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 20,
  },
  backText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  cardVisual: {
    borderRadius: 16,
    padding: 20,
    minHeight: 170,
    justifyContent: 'space-between',
  },
  cardPan: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  cardNickname: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '500',
  },
  cardNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardLabelInput: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.6)',
    paddingVertical: 0,
  },
  renameActions: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    gap: 12,
  },
  renameHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  renameButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  renameButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  renameCancelButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
  },
  renameCancelText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  renameSaveButton: {
    backgroundColor: colors.accent,
  },
  renameSaveText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  renameNote: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  infoBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  infoLabel: {
    color: colors.muted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  infoValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
  windowBanner: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.success,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  windowTitle: {
    color: colors.success,
    fontSize: 15,
    fontWeight: '700',
  },
  windowText: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  detailsBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 12,
    paddingHorizontal: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailText: {
    flexShrink: 1,
  },
  detailLabel: {
    color: colors.muted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  detailValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 2,
  },
  copyText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 16,
  },
  clipboardNote: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 10,
  },
  otpReveal: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    alignItems: 'center',
  },
  otpRevealTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  otpValue: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 8,
    marginVertical: 10,
  },
  otpCopyButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  otpCopyText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  otpAnotherButton: {
    marginTop: 14,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  otpAnotherText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  otpAnotherNote: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 14,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderColor: colors.accent,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  secondaryButtonText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  pendingBox: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    alignItems: 'center',
  },
  pendingText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  formBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  historyBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 24,
    paddingHorizontal: 16,
  },
  historyTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    paddingTop: 14,
    paddingBottom: 6,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  historyLabel: {
    color: colors.text,
    fontSize: 14,
  },
  historyRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  historyStatus: {
    color: colors.muted,
    fontSize: 12,
  },
});
