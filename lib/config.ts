// Runtime configuration. In production set EXPO_PUBLIC_RELAY_URL to the
// HTTPS origin of the deployed relay (baked in at build time by Expo):
//   EXPO_PUBLIC_RELAY_URL=https://app.example.com npx expo export
// Unset, the relay runs on the same machine as the Metro dev server, so its
// host is derived from the dev server URI instead of hardcoding localhost
// (which would break on physical devices).

import Constants from 'expo-constants';

const RELAY_PORT = 8787;

let cached: string | null = null;

export function getRelayUrl(): string {
  if (cached) return cached;
  const fromEnv = process.env.EXPO_PUBLIC_RELAY_URL?.trim();
  if (fromEnv) {
    const url = fromEnv.replace(/\/+$/, '');
    cached = url;
    return url;
  }
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as unknown as { expoGoConfig?: { debuggerHost?: string } })
      .expoGoConfig?.debuggerHost;
  const host = hostUri?.split(':')[0];
  cached = host ? `http://${host}:${RELAY_PORT}` : `http://localhost:${RELAY_PORT}`;
  return cached;
}
