// Node stub for expo-crypto (used only by scripts/crypto.test.ts).
import { randomBytes } from 'node:crypto';

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(byteCount));
}

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount));
}

export function getRandomValues(typedArray: Uint8Array): Uint8Array {
  typedArray.set(randomBytes(typedArray.length));
  return typedArray;
}

export function randomUUID(): string {
  return randomBytes(16).toString('hex');
}
