import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuthStore } from '../lib/auth';
import { getIdentity } from '../lib/identity';
import { setupNotifications } from '../lib/notify';
import { pollInbox, registerDevice, startPolling, stopPolling } from '../lib/relay';
import { colors } from '../lib/theme';

export default function RootLayout() {
  const { locked, ready, protectedDevice, lastAuthNote, init, unlock, lock } =
    useAuthStore();
  const unlocking = useRef(false);

  useEffect(() => {
    init();
    setupNotifications();
  }, [init]);

  // Register this device with the relay once identity exists.
  useEffect(() => {
    if (!ready) return;
    getIdentity()
      .then(() => registerDevice())
      .catch(() => {});
  }, [ready]);

  // Poll the relay while the vault is unlocked; stop when locked/backgrounded.
  useEffect(() => {
    if (ready && !locked) {
      startPolling();
    } else {
      stopPolling();
    }
    return () => stopPolling();
  }, [ready, locked]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        stopPolling();
        lock();
      } else if (state === 'active' && !useAuthStore.getState().locked) {
        void registerDevice();
        pollInbox().catch(() => {});
        startPolling();
      }
    });
    return () => sub.remove();
  }, [lock]);

  const tryUnlock = async () => {
    if (unlocking.current) return;
    unlocking.current = true;
    try {
      await unlock();
    } finally {
      unlocking.current = false;
    }
  };

  // Prompt biometrics as soon as the app is ready and locked.
  useEffect(() => {
    if (ready && locked) {
      tryUnlock();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, locked]);

  if (!ready) {
    return <View style={styles.root} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" />
      </Stack>
      {locked && (
        <View style={[StyleSheet.absoluteFill, styles.lockScreen]}>
          <Text style={styles.lockTitle}>CardVault</Text>
          <Text style={styles.lockSubtitle}>Your cards, on this phone only.</Text>
          <Pressable style={styles.unlockButton} onPress={tryUnlock}>
            <Text style={styles.unlockButtonText}>Unlock</Text>
          </Pressable>
          {lastAuthNote ? (
            <Text style={styles.devWarning}>{lastAuthNote}</Text>
          ) : (
            !protectedDevice && (
              <Text style={styles.devWarning}>
                Biometrics unavailable on this device - vault is unprotected
                (dev mode).
              </Text>
            )
          )}
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  lockScreen: {
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  lockTitle: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  lockSubtitle: {
    color: colors.muted,
    fontSize: 15,
    marginTop: 8,
  },
  unlockButton: {
    marginTop: 32,
    backgroundColor: colors.accent,
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
  },
  unlockButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  devWarning: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
  },
});
