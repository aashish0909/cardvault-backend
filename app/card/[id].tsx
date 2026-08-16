import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authenticateOnce } from '../../lib/auth';
import { CardLogo } from '../../components/CardLogo';
import { formatPan, maskedPan } from '../../lib/cards';
import { decryptJSON } from '../../lib/crypto';
import { CardRow, CardSecrets, deleteCard, getCard } from '../../lib/db';
import { colors } from '../../lib/theme';

const REVEAL_SECONDS = 60;

export default function CardDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [card, setCard] = useState<CardRow | null>(null);
  const [secrets, setSecrets] = useState<CardSecrets | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (id) {
      getCard(id).then(setCard);
    }
  }, [id]);

  const hideSecrets = useCallback(() => {
    setSecrets(null);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  // Auto re-mask when leaving the screen and clear any pending timers.
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    };
  }, []);

  const onReveal = async () => {
    if (!card || secrets) {
      hideSecrets();
      return;
    }
    const ok = await authenticateOnce('Reveal card details');
    if (!ok) return;
    try {
      const decrypted = await decryptJSON<CardSecrets>(card.payload);
      setSecrets(decrypted);
      hideTimer.current = setTimeout(hideSecrets, REVEAL_SECONDS * 1000);
    } catch (e) {
      Alert.alert('Could not decrypt card', String(e));
    }
  };

  const onCopy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopiedField(label);
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    // Clipboard auto-clear: wipe sensitive data after 60 seconds.
    clipboardTimer.current = setTimeout(async () => {
      const current = await Clipboard.getStringAsync();
      if (current === value) {
        await Clipboard.setStringAsync('');
      }
      setCopiedField(null);
    }, REVEAL_SECONDS * 1000);
  };

  const onDelete = () => {
    if (!card) return;
    Alert.alert(
      'Delete card',
      `Remove "${card.nickname}" from this device? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteCard(card.id);
            router.back();
          },
        },
      ]
    );
  };

  if (!card) {
    return <View style={styles.container} />;
  }

  const revealed = secrets !== null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 16 },
      ]}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.headerActions}>
          <Pressable onPress={() => router.push(`/share-card?id=${card.id}`)} hitSlop={12}>
            <Text style={styles.shareText}>Share</Text>
          </Pressable>
          <Pressable onPress={onDelete} hitSlop={12}>
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.cardVisual, { backgroundColor: card.color }]}>
        <CardLogo network={card.network} width={48} />
        <Text style={styles.cardPan}>
          {revealed ? formatPan(secrets.pan) : maskedPan(card.last4)}
        </Text>
        <View style={styles.cardBottomRow}>
          <View>
            <Text style={styles.cardFieldLabel}>CARD HOLDER</Text>
            <Text style={styles.cardFieldValue}>
              {revealed ? secrets.holderName : card.nickname}
            </Text>
          </View>
          <View>
            <Text style={styles.cardFieldLabel}>EXPIRES</Text>
            <Text style={styles.cardFieldValue}>
              {revealed ? secrets.expiry : '**/**'}
            </Text>
          </View>
        </View>
      </View>

      <Pressable style={styles.revealButton} onPress={onReveal}>
        <Text style={styles.revealButtonText}>
          {revealed ? `Hide (auto-hides in ${REVEAL_SECONDS}s)` : 'Reveal details'}
        </Text>
      </Pressable>

      {revealed && (
        <View style={styles.detailsBox}>
          <DetailRow
            label="Card number"
            value={formatPan(secrets.pan)}
            copied={copiedField === 'pan'}
            onCopy={() => onCopy('pan', secrets.pan)}
          />
          <DetailRow
            label="Expiry"
            value={secrets.expiry}
            copied={copiedField === 'expiry'}
            onCopy={() => onCopy('expiry', secrets.expiry)}
          />
          <DetailRow
            label="CVV"
            value={secrets.cvv}
            copied={copiedField === 'cvv'}
            onCopy={() => onCopy('cvv', secrets.cvv)}
          />
          <Text style={styles.clipboardNote}>
            Copied values are wiped from the clipboard after {REVEAL_SECONDS}{' '}
            seconds.
          </Text>
        </View>
      )}
    </ScrollView>
  );
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 20,
  },
  backText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  shareText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  deleteText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: '500',
  },
  cardVisual: {
    borderRadius: 16,
    padding: 20,
    minHeight: 190,
    justifyContent: 'space-between',
  },
  cardPan: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  cardBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cardFieldLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    letterSpacing: 1,
  },
  cardFieldValue: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  revealButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  revealButtonText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  detailsBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 16,
    paddingHorizontal: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailText: {
    flexShrink: 1,
  },
  detailLabel: {
    color: colors.muted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  detailValue: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
    marginTop: 2,
  },
  copyText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 16,
  },
  clipboardNote: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 12,
  },
});
