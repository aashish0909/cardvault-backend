// Biometric app lock (expo-local-authentication) + lock state (zustand).
//
// Environment reality (SDK 54 docs): Face ID does NOT work inside iOS Expo
// Go. The device reports biometrics as enrolled, but authenticateAsync fails
// with `not_available`. To keep the app usable during development, auth
// failures of that class fall back to an unlocked state ONLY when __DEV__ is
// true, and the reason is surfaced on the lock screen. Production builds
// never fall back: a failed prompt keeps the vault locked.
//
// Phase 4 hardening TODO: enforce biometrics (or device passcode) strictly in
// release builds, and re-enable SecureStore `requireAuthentication` on the
// vault key (also unsupported in Expo Go).

import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { create } from 'zustand';

/** True when running inside the Expo Go sandbox (as opposed to a dev/release build). */
export const isExpoGo = Constants.appOwnership === 'expo';

/** Face ID cannot prompt inside iOS Expo Go (documented Expo limitation). */
export const faceIdBlockedByExpoGo = isExpoGo && Platform.OS === 'ios';

// Errors after which a dev build may fall back to unlocked. Anything else
// (user_cancel, lockout, authentication_failed, ...) keeps the vault locked.
const DEV_FALLBACK_ERRORS = new Set([
  'not_available',
  'not_enrolled',
  'passcode_not_set',
]);

export async function biometricsAvailable(): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return false;
  return LocalAuthentication.isEnrolledAsync();
}

/**
 * Single biometric prompt. Returns true on success. In __DEV__ only, also
 * returns true when the device cannot prompt at all (Expo Go Face ID block,
 * no enrollment) - that case is visible in the UI via lastAuthNote.
 */
export async function authenticateOnce(promptMessage: string): Promise<boolean> {
  if (!(await biometricsAvailable())) {
    useAuthStore.getState().setLastAuthNote('no biometrics enrolled (dev unlock)');
    return __DEV__;
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
  });
  if (result.success) return true;

  const code = result.error ?? 'unknown';
  useAuthStore.getState().setLastAuthNote(`prompt failed: ${code}`);
  if (__DEV__ && DEV_FALLBACK_ERRORS.has(code)) {
    return true;
  }
  return false;
}

interface AuthState {
  locked: boolean;
  ready: boolean;
  protectedDevice: boolean;
  lastAuthNote: string | null;
  init: () => Promise<void>;
  unlock: () => Promise<boolean>;
  lock: () => void;
  setLastAuthNote: (note: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  locked: true,
  ready: false,
  protectedDevice: false,
  lastAuthNote: null,

  init: async () => {
    const available = await biometricsAvailable();
    set({ protectedDevice: available && !faceIdBlockedByExpoGo, ready: true });
  },

  unlock: async () => {
    // In iOS Expo Go the Face ID prompt can never appear - skip the doomed
    // call and go straight to the dev fallback.
    if (faceIdBlockedByExpoGo) {
      set({
        locked: false,
        lastAuthNote: __DEV__
          ? 'Face ID is unavailable inside Expo Go - unlocked in dev mode'
          : 'authentication unavailable',
      });
      return __DEV__;
    }
    const ok = await authenticateOnce('Unlock CardVault');
    if (ok) set({ locked: false });
    return ok;
  },

  lock: () => set({ locked: true }),

  setLastAuthNote: (note) => set({ lastAuthNote: note }),
}));
