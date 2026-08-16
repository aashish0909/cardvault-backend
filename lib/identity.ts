// Device identity: an X25519 keypair + device id + display name.
//
// Generated once, stored in expo-secure-store (Keychain/Keystore). The secret
// key never leaves this device. The public key is what gets shared via QR to
// establish peer trust, and pairing payloads are signed implicitly by
// encrypting to the recipient's public key (nacl box authentication).

import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';

import { bytesToHex } from './bytes';

// tweetnacl needs a random source. Hermes (RN 0.81) does not expose a
// WebCrypto getRandomValues that tweetnacl can auto-detect, so it throws
// "no PRNG" on device. Wire it to expo-crypto's native CSPRNG explicitly.
// This must run before any nacl.randomBytes call (e.g. identity keypair
// generation, E2E nonces) - identity is imported by everything that seals.
nacl.setPRNG((x: Uint8Array) => {
  Crypto.getRandomValues(x);
});

const IDENTITY_KEY = 'cardvault.identity.v1';

export interface Identity {
  deviceId: string;
  name: string;
  pubHex: string;
  secretHex: string;
}

let cached: Identity | null = null;

export function generateIdentity(name?: string): Identity {
  const pair = nacl.box.keyPair();
  const deviceName =
    name ??
    (typeof Device.deviceName === 'string' && Device.deviceName
      ? Device.deviceName
      : 'Friend');
  return {
    deviceId: Crypto.randomUUID(),
    name: deviceName.trim().slice(0, 40) || 'Friend',
    pubHex: bytesToHex(pair.publicKey),
    secretHex: bytesToHex(pair.secretKey),
  };
}

/** Load the persisted identity, or create + persist one. */
export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  const raw = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (raw) {
    cached = JSON.parse(raw) as Identity;
    return cached;
  }
  const identity = generateIdentity();
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cached = identity;
  return identity;
}

/** Persist a new display name; friends see it after the next name-update relay. */
export async function updateIdentityName(name: string): Promise<Identity> {
  const current = await getIdentity();
  const next = {
    ...current,
    name: name.trim().slice(0, 40) || 'Friend',
  };
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(next), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cached = next;
  return next;
}

/** The QR / clipboard payload another device scans to initiate pairing. */
export function pairingPayload(identity: Identity): string {
  return JSON.stringify({
    v: 1,
    deviceId: identity.deviceId,
    name: identity.name,
    pub: identity.pubHex,
  });
}

/** Short visual fingerprint of the public key for human verification. */
export async function pairingFingerprint(pubHex: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    pubHex
  );
  return digest.slice(0, 8).toUpperCase();
}
