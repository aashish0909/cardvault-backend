// Byte codecs shared by the vault (lib/crypto.ts) and E2E (lib/e2e.ts) layers.

import CryptoJS from 'crypto-js';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] = (words[i >>> 2] ?? 0) | (bytes[i] << (24 - (i % 4) * 8));
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

export function wordArrayToBytes(wa: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wa.sigBytes);
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  return bytesToWordArray(bytes).toString(CryptoJS.enc.Base64);
}

export function base64Decode(value: string): Uint8Array {
  return wordArrayToBytes(CryptoJS.enc.Base64.parse(value));
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
