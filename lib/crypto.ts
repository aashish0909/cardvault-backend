// Vault encryption (SDK 54 edition).
//
// expo-crypto's native AES-GCM API only exists in SDK 55+, which Expo Go does
// not support yet. So for now we use crypto-js with an equivalent-strength,
// conservative construction:
//
//   - 512 bits of key material from the native CSPRNG (expo-crypto),
//     split into an independent 256-bit AES key and 256-bit HMAC key
//   - AES-256-CBC with a fresh random 16-byte IV per record (PKCS7 padding)
//   - HMAC-SHA256 over IV || ciphertext, verified before decrypt (EtM)
//
// Payload layout: base64( IV(16) || ciphertext || HMAC tag(32) ).
//
// The key material lives in expo-secure-store (iOS Keychain / Android
// Keystore) with WHEN_UNLOCKED_THIS_DEVICE_ONLY. We intentionally do NOT use
// SecureStore's requireAuthentication: it is unsupported in Expo Go.
// Biometric gating happens at the app-lock / reveal level (see lib/auth.ts).
//
// MIGRATION PATH (Phase 3/4, dev build): move to libsodium secretbox or back
// to native expo-crypto AES-GCM after re-upgrading the SDK.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import CryptoJS from 'crypto-js';

import {
  base64Encode,
  bytesToHex,
  bytesToWordArray,
  concatBytes,
  constantTimeEqual,
  hexToBytes,
  wordArrayToBytes,
} from './bytes';

const MASTER_KEY_ID = 'cardvault.masterKey.v1';
const IV_LENGTH = 16;
const TAG_LENGTH = 32;
const KEY_MATERIAL_LENGTH = 64; // 32 B AES key || 32 B HMAC key

let cachedEncKey: CryptoJS.lib.WordArray | null = null;
let cachedMacKey: CryptoJS.lib.WordArray | null = null;

async function getKeys(): Promise<{
  encKey: CryptoJS.lib.WordArray;
  macKey: CryptoJS.lib.WordArray;
}> {
  if (cachedEncKey && cachedMacKey) {
    return { encKey: cachedEncKey, macKey: cachedMacKey };
  }

  const existing = await SecureStore.getItemAsync(MASTER_KEY_ID);
  let material: Uint8Array;
  if (existing) {
    material = hexToBytes(existing);
  } else {
    material = await Crypto.getRandomBytesAsync(KEY_MATERIAL_LENGTH);
    await SecureStore.setItemAsync(MASTER_KEY_ID, bytesToHex(material), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  cachedEncKey = bytesToWordArray(material.subarray(0, 32));
  cachedMacKey = bytesToWordArray(material.subarray(32, 64));
  return { encKey: cachedEncKey, macKey: cachedMacKey };
}

/** Encrypt a JSON-serializable value; returns base64( IV || CT || HMAC ). */
export async function encryptJSON(value: unknown): Promise<string> {
  const { encKey, macKey } = await getKeys();
  const iv = await Crypto.getRandomBytesAsync(IV_LENGTH);
  const plaintextWA = bytesToWordArray(
    new TextEncoder().encode(JSON.stringify(value))
  );

  const encrypted = CryptoJS.AES.encrypt(plaintextWA, encKey, {
    iv: bytesToWordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const ct = wordArrayToBytes(encrypted.ciphertext);

  // HMAC over IV || ciphertext (Encrypt-then-MAC).
  const tag = wordArrayToBytes(
    CryptoJS.HmacSHA256(bytesToWordArray(concatBytes(iv, ct)), macKey)
  );

  return base64Encode(concatBytes(iv, ct, tag));
}

/** Decrypt a payload produced by encryptJSON. Throws if tampered / wrong key. */
export async function decryptJSON<T>(payload: string): Promise<T> {
  const { encKey, macKey } = await getKeys();
  const bytes = wordArrayToBytes(CryptoJS.enc.Base64.parse(payload));
  if (bytes.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Malformed vault payload');
  }

  const iv = bytes.subarray(0, IV_LENGTH);
  const ct = bytes.subarray(IV_LENGTH, bytes.length - TAG_LENGTH);
  const tag = bytes.subarray(bytes.length - TAG_LENGTH);

  // Verify MAC before touching the ciphertext (Encrypt-then-MAC).
  const expectedTag = CryptoJS.HmacSHA256(
    bytesToWordArray(concatBytes(iv, ct)),
    macKey
  );
  if (!constantTimeEqual(wordArrayToBytes(expectedTag), tag)) {
    throw new Error('Vault payload failed integrity check');
  }

  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.lib.CipherParams.create({ ciphertext: bytesToWordArray(ct) }),
    encKey,
    {
      iv: bytesToWordArray(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }
  );

  return JSON.parse(
    new TextDecoder().decode(wordArrayToBytes(decrypted))
  ) as T;
}
