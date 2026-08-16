import { randomBytes } from 'node:crypto';

import { CODE_ALPHABET, MAX_WAITERS, MAX_WAITERS_PER_IP } from './config';
import type { BlobRecord, DeviceRecord, PairingCodeRecord, Waiter } from './types';

export const devices = new Map<string, DeviceRecord>();
export const blobs = new Map<string, BlobRecord>();
export const pairingCodes = new Map<string, PairingCodeRecord>();

// Live blob count per recipient (mirrors `to` fields in `blobs`) so the
// per-inbox cap is O(1) to enforce.
export const pendingBlobs = new Map<string, number>();

// Single-use request nonces: `${deviceId}:${nonce}` -> seen at (ms).
export const seenNonces = new Map<string, number>();

// Long-poll waiters: deviceId -> callbacks held in pending GET /v1/blobs.
// Deposits wake them so pickups return the moment a blob lands.
export const waiters = new Map<string, Waiter[]>();
export const waiterCountByIp = new Map<string, number>();

export function waiterTotal(): number {
  let n = 0;
  for (const list of waiters.values()) n += list.length;
  return n;
}

export function addWaiter(deviceId: string, ip: string, wake: () => void): boolean {
  if (waiterTotal() >= MAX_WAITERS) return false;
  if ((waiterCountByIp.get(ip) ?? 0) >= MAX_WAITERS_PER_IP) return false;
  const list = waiters.get(deviceId) ?? [];
  list.push({ wake, ip });
  waiters.set(deviceId, list);
  waiterCountByIp.set(ip, (waiterCountByIp.get(ip) ?? 0) + 1);
  return true;
}

export function removeWaiter(deviceId: string, wake: () => void): void {
  const list = waiters.get(deviceId);
  if (!list) return;
  const i = list.findIndex((w) => w.wake === wake);
  if (i < 0) return;
  const [removed] = list.splice(i, 1);
  if (removed) {
    const next = (waiterCountByIp.get(removed.ip) ?? 1) - 1;
    if (next > 0) waiterCountByIp.set(removed.ip, next);
    else waiterCountByIp.delete(removed.ip);
  }
  if (list.length === 0) waiters.delete(deviceId);
}

export function wakeWaiters(deviceId: string): boolean {
  const pending = waiters.get(deviceId);
  if (!pending || pending.length === 0) return false;
  waiters.delete(deviceId);
  for (const w of pending) {
    const next = (waiterCountByIp.get(w.ip) ?? 1) - 1;
    if (next > 0) waiterCountByIp.set(w.ip, next);
    else waiterCountByIp.delete(w.ip);
    w.wake();
  }
  return true;
}

export function touchDevice(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device) device.lastSeen = Date.now();
}

export function isPushable(device: DeviceRecord): boolean {
  return Boolean(device.pushToken || device.pushSubscription);
}

export function randomPairingCode(): string {
  // Rejection sampling so every alphabet character is equally likely.
  const out: string[] = [];
  const bound = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (out.length < 8) {
    const b = randomBytes(1)[0]!;
    if (b >= bound) continue;
    out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  }
  return out.join('');
}

export function incPending(to: string): void {
  pendingBlobs.set(to, (pendingBlobs.get(to) ?? 0) + 1);
}

export function decPending(to: string): void {
  const next = (pendingBlobs.get(to) ?? 1) - 1;
  if (next > 0) pendingBlobs.set(to, next);
  else pendingBlobs.delete(to);
}

export function deleteBlob(id: string): boolean {
  const blob = blobs.get(id);
  if (!blob) return false;
  blobs.delete(id);
  decPending(blob.to);
  return true;
}
