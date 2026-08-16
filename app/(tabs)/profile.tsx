import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getIdentity, updateIdentityName } from '../../lib/identity';
import { sendNameUpdate } from '../../lib/relay';
import { colors } from '../../lib/theme';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getIdentity().then((identity) => {
      setName(identity.name);
      setLoaded(true);
    });
  }, []);

  const onSave = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Name required', 'Enter a name your friends will see.');
      return;
    }
    const identity = await updateIdentityName(trimmed);
    await sendNameUpdate(identity.name).catch(() => {});
    Alert.alert(
      'Saved',
      'Your name is now "' + identity.name + '". Friends will see the update on their next sync.'
    );
  }, [name]);

  if (!loaded) return <View style={styles.container} />;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Display name</Text>
        <Text style={styles.hint}>
          This is what your friends see in their Friends list, and what appears
          on your pairing code.
        </Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={colors.muted}
          maxLength={40}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
        />
        <Pressable style={styles.saveButton} onPress={onSave}>
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      </View>
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
  card: {
    marginHorizontal: 20,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  label: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  hint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
