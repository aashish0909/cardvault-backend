import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getIdentity,
  pairingPayload,
} from '../../lib/identity';
import {
  createPairingCode,
  formatPairingCode,
  PAIRING_CODE_TTL_MIN,
} from '../../lib/pairing';
import { colors } from '../../lib/theme';

export default function MyQrScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [payload, setPayload] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshCode = useCallback(async () => {
    setCodeError(null);
    try {
      setCode(await createPairingCode());
    } catch (e) {
      setCode(null);
      setCodeError(String(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const identity = await getIdentity();
      setPayload(pairingPayload(identity));
      setName(identity.name);
    })();
    refreshCode();
  }, [refreshCode]);

  const onCopy = async () => {
    if (!code) return;
    await Clipboard.setStringAsync(formatPairingCode(code));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>My QR</Text>
      </View>

      <View style={styles.qrBox}>
        {payload ? (
          <QRCode value={payload} size={240} backgroundColor="#FFFFFF" color="#0B0F14" />
        ) : (
          <View style={styles.qrPlaceholder} />
        )}
      </View>

      <Text style={styles.name}>{name}</Text>

      <View style={styles.codeBox}>
        <Text style={styles.codeLabel}>
          Pairing code · expires in {PAIRING_CODE_TTL_MIN} min
        </Text>
        <Text style={styles.codeValue}>
          {code ? formatPairingCode(code) : codeError ? '—' : '…'}
        </Text>
        {codeError && <Text style={styles.codeError}>{codeError}</Text>}
        <View style={styles.codeActions}>
          <Pressable style={styles.codeButton} onPress={onCopy} disabled={!code}>
            <Text style={styles.codeButtonText}>
              {copied ? 'Copied!' : 'Copy code'}
            </Text>
          </Pressable>
          <Pressable style={styles.codeButton} onPress={refreshCode}>
            <Text style={styles.codeButtonText}>New code</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.note}>
        The QR and code contain only your public key, name and device id - your
        cards never leave this phone. After they send a request, both of you
        will see the same fingerprint — compare those numbers before you
        accept. Pairing codes expire after {PAIRING_CODE_TTL_MIN} minutes.
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
  qrBox: {
    alignSelf: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
  },
  qrPlaceholder: {
    width: 240,
    height: 240,
  },
  name: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 20,
  },
  codeBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    alignItems: 'center',
  },
  codeLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  codeValue: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 3,
    marginVertical: 10,
    fontVariant: ['tabular-nums'],
  },
  codeError: {
    color: colors.danger,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 6,
  },
  codeActions: {
    flexDirection: 'row',
    gap: 10,
  },
  codeButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  codeButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  note: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
    lineHeight: 18,
  },
});
