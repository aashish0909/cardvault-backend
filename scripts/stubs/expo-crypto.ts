// Node stub for expo-crypto (used only by scripts/*.test.ts).
import { createHash, randomBytes } from 'node:crypto';

export enum CryptoDigestAlgorithm {
  SHA256 = 'SHA-256',
}

export enum CryptoEncoding {
  HEX = 'hex',
  BASE64 = 'base64',
}

export async function digestStringAsync(
  algorithm: string,
  data: string,
  options: { encoding?: string } = { encoding: CryptoEncoding.HEX }
): Promise<string> {
  const nodeAlgo = algorithm === 'SHA-256' ? 'sha256' : algorithm.toLowerCase().replace('-', '');
  const hash = createHash(nodeAlgo).update(data, 'utf8');
  return options.encoding === CryptoEncoding.BASE64 ? hash.digest('base64') : hash.digest('hex');
}

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
