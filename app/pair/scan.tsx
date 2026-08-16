import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hexToBytes } from '../../lib/bytes';
import { getIdentity } from '../../lib/identity';
import {
  PAIRING_CODE_LENGTH,
  resolvePairingCode,
  type PairPayload,
} from '../../lib/pairing';
import { sendBlob } from '../../lib/relay';
import { colors } from '../../lib/theme';
import { upsertPeer } from '../../lib/db';

function parsePairPayload(raw: string): PairPayload | null {
  try {
    const data = JSON.parse(raw) as PairPayload;
    if (
      data.v !== 1 ||
      typeof data.deviceId !== 'string' ||
      data.deviceId.length === 0 ||
      typeof data.name !== 'string' ||
      typeof data.pub !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(data.pub)
    ) {
      return null;
    }
    hexToBytes(data.pub); // sanity
    return data;
  } catch {
    return null;
  }
}

export default function PairScanScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [permission, requestPermission] = useCameraPermissions();
  const [codeDraft, setCodeDraft] = useState('');
  const [codeFocused, setCodeFocused] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>(
    'idle'
  );
  const [message, setMessage] = useState('');
  const codeInput = useRef<TextInput>(null);

  const handlePayload = async (raw: string) => {
    const parsed = parsePairPayload(raw);
    if (!parsed) {
      setState('error');
      setMessage('That code is not a valid CardVault pairing code.');
      return;
    }
    setState('sending');
    try {
      const identity = await getIdentity();
      await upsertPeer({
        id: parsed.deviceId,
        name: parsed.name,
        publicKey: parsed.pub,
        direction: 'out',
        status: 'pending',
      });
      await sendBlob(parsed.deviceId, 'pair-request', {
        v: 1,
        deviceId: identity.deviceId,
        name: identity.name,
        pub: identity.pubHex,
      });
      setMessage(
        `Pairing request sent to ${parsed.name}. They just need to accept it.`
      );
      setState('done');
    } catch (e) {
      setState('error');
      setMessage(`Could not send the request: ${String(e)}`);
    }
  };

  const onCodeSend = async () => {
    const code = codeDraft.trim();
    if (code.length !== PAIRING_CODE_LENGTH || state === 'sending') return;
    setState('sending');
    try {
      const payload = await resolvePairingCode(code);
      await handlePayload(JSON.stringify(payload));
    } catch (e) {
      setState('error');
      setMessage(String(e));
    }
  };

  const onCodeChange = (raw: string) => {
    const clean = raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, PAIRING_CODE_LENGTH);
    setCodeDraft(clean);
    if (clean.length === PAIRING_CODE_LENGTH && state === 'idle') {
      onCodeSend();
    }
  };

  const showCamera = permission?.granted === true && state === 'idle';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Scan a friend's QR</Text>
      </View>

      {showCamera ? (
        <View style={styles.cameraBox}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              handlePayload(data);
            }}
          />
        </View>
      ) : (
        <View style={styles.cameraFallback}>
          <Text style={styles.fallbackTitle}>
            {state === 'idle' ? 'Camera not ready' : 'Scan complete'}
          </Text>
          <Text style={styles.fallbackText}>
            {permission && !permission.granted && permission.canAskAgain ? (
              <Text onPress={requestPermission} style={styles.retryText}>
                Grant camera access to scan, or enter your friend's pairing
                code below.
              </Text>
            ) : (
              'Ask your friend to open "My QR" and share their pairing code.'
            )}
          </Text>
        </View>
      )}

      {state === 'sending' && (
        <ActivityIndicator color={colors.accent} size="large" style={styles.spinner} />
      )}

      <View style={styles.manualBox}>
        <Text style={styles.manualLabel}>Or enter their pairing code</Text>
        <Pressable style={styles.otpRow} onPress={() => codeInput.current?.focus()}>
          <View style={styles.otpCells}>
            {Array.from({ length: PAIRING_CODE_LENGTH }, (_, i) => {
              const char = codeDraft[i];
              const isFocused = codeFocused && i === codeDraft.length;
              return (
                <View
                  key={i}
                  style={[
                    styles.otpCell,
                    i === 4 && styles.otpCellGap,
                    char !== undefined && styles.otpCellFilled,
                    isFocused && styles.otpCellActive,
                  ]}
                >
                  <Text style={styles.otpCellText}>{char ?? ''}</Text>
                </View>
              );
            })}
          </View>
          <TextInput
            ref={codeInput}
            style={styles.hiddenInput}
            value={codeDraft}
            onChangeText={onCodeChange}
            onFocus={() => setCodeFocused(true)}
            onBlur={() => setCodeFocused(false)}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={PAIRING_CODE_LENGTH}
            keyboardType="ascii-capable"
            caretHidden
          />
        </Pressable>
        <Text style={styles.manualHint}>
          The code is in your friend's My QR screen and expires after 5
          minutes.
        </Text>
        <Pressable
          style={[
            styles.sendButton,
            (codeDraft.length !== PAIRING_CODE_LENGTH ||
              state === 'sending') &&
              styles.sendButtonDisabled,
          ]}
          onPress={onCodeSend}
          disabled={
            codeDraft.length !== PAIRING_CODE_LENGTH || state === 'sending'
          }
        >
          <Text style={styles.sendButtonText}>Send pairing request</Text>
        </Pressable>
      </View>

      {state === 'done' && (
        <View style={styles.doneBanner}>
          <Text style={styles.doneText}>{message}</Text>
          <Pressable style={styles.doneButton} onPress={() => router.back()}>
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
        </View>
      )}
      {state === 'error' && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{message}</Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => {
              setState('idle');
              setCodeDraft('');
              setMessage('');
            }}
          >
            <Text style={styles.retryButtonText}>Try again</Text>
          </Pressable>
        </View>
      )}
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
  cameraBox: {
    height: 260,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFallback: {
    height: 160,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  fallbackTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  fallbackText: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
  },
  retryText: {
    color: colors.accent,
    fontWeight: '600',
  },
  spinner: {
    marginTop: 16,
  },
  manualBox: {
    marginTop: 20,
  },
  manualLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  otpRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  otpCells: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  otpCell: {
    width: 36,
    height: 46,
    marginHorizontal: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpCellGap: {
    marginLeft: 16,
  },
  otpCellFilled: {
    borderColor: colors.accent,
  },
  otpCellActive: {
    borderColor: colors.accent,
    borderWidth: 2,
  },
  otpCellText: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  manualHint: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  doneBanner: {
    marginTop: 16,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.success,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  doneText: {
    color: colors.text,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  doneButton: {
    marginTop: 12,
    backgroundColor: colors.success,
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  doneButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  errorBanner: {
    marginTop: 16,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 12,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 9,
  },
  retryButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});
