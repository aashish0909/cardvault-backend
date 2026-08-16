import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  colorForNetwork,
  detectNetwork,
  digitsOnly,
  formatPan,
  isValidCvv,
  isValidExpiry,
  luhnCheck,
  NETWORK_LABELS,
} from '../lib/cards';
import { encryptJSON } from '../lib/crypto';
import { insertCard } from '../lib/db';
import { colors } from '../lib/theme';

export default function AddCardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [nickname, setNickname] = useState('');
  const [holderName, setHolderName] = useState('');
  const [pan, setPan] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [saving, setSaving] = useState(false);

  const panDigits = digitsOnly(pan);
  const network = detectNetwork(panDigits);

  const onChangePan = (value: string) => {
    setPan(formatPan(digitsOnly(value).slice(0, 19)));
  };

  const onChangeExpiry = (value: string) => {
    const d = digitsOnly(value).slice(0, 4);
    setExpiry(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d);
  };

  const validate = (): string | null => {
    if (!nickname.trim()) return 'Give the card a nickname.';
    if (!holderName.trim()) return 'Enter the name on the card.';
    if (!luhnCheck(panDigits)) return 'Card number looks invalid.';
    if (!isValidExpiry(expiry)) return 'Expiry must be a valid future MM/YY.';
    if (!isValidCvv(cvv, network))
      return network === 'amex' ? 'CVV must be 4 digits.' : 'CVV must be 3 digits.';
    return null;
  };

  const onSave = async () => {
    const error = validate();
    if (error) {
      Alert.alert('Check the details', error);
      return;
    }
    setSaving(true);
    try {
      const payload = await encryptJSON({
        holderName: holderName.trim(),
        pan: panDigits,
        expiry,
        cvv: digitsOnly(cvv),
      });
      await insertCard({
        nickname: nickname.trim(),
        network,
        last4: panDigits.slice(-4),
        color: colorForNetwork(network),
        payload,
      });
      router.back();
    } catch (e) {
      Alert.alert('Could not save card', String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 16 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Add Card</Text>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <Text style={styles.label}>Nickname</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. HDFC Millennia"
          placeholderTextColor={colors.muted}
          value={nickname}
          onChangeText={setNickname}
          autoFocus
        />

        <Text style={styles.label}>Name on card</Text>
        <TextInput
          style={styles.input}
          placeholder="AASHISH KUMAR"
          placeholderTextColor={colors.muted}
          value={holderName}
          onChangeText={setHolderName}
          autoCapitalize="characters"
        />

        <View style={styles.panLabelRow}>
          <Text style={styles.label}>Card number</Text>
          {panDigits.length > 1 && (
            <Text style={styles.networkBadge}>{NETWORK_LABELS[network]}</Text>
          )}
        </View>
        <TextInput
          style={styles.input}
          placeholder="4242 4242 4242 4242"
          placeholderTextColor={colors.muted}
          value={pan}
          onChangeText={onChangePan}
          keyboardType="number-pad"
        />

        <View style={styles.row}>
          <View style={styles.half}>
            <Text style={styles.label}>Expiry</Text>
            <TextInput
              style={styles.input}
              placeholder="MM/YY"
              placeholderTextColor={colors.muted}
              value={expiry}
              onChangeText={onChangeExpiry}
              keyboardType="number-pad"
            />
          </View>
          <View style={styles.half}>
            <Text style={styles.label}>CVV</Text>
            <TextInput
              style={styles.input}
              placeholder="123"
              placeholderTextColor={colors.muted}
              value={cvv}
              onChangeText={(v) => setCvv(digitsOnly(v).slice(0, 4))}
              keyboardType="number-pad"
              secureTextEntry
            />
          </View>
        </View>

        <Pressable
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={onSave}
          disabled={saving}
        >
          <Text style={styles.saveButtonText}>
            {saving ? 'Encrypting...' : 'Save to Vault'}
          </Text>
        </Pressable>

        <Text style={styles.note}>
          Card number, expiry and CVV are encrypted on this device. Nothing is
          uploaded anywhere.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  closeText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  panLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  networkBadge: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 17,
    marginBottom: 20,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  half: {
    flex: 1,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
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
