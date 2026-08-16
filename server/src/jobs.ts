import { DEVICE_STALE_MS, NONCE_RETENTION_MS, RATE_WINDOW_MS, SWEEP_INTERVAL_MS } from './config';
import { sweepRateBuckets } from './http';
import { persistDevices } from './persist';
import {
  blobs,
  deleteBlob,
  devices,
  isPushable,
  pairingCodes,
  pendingBlobs,
  seenNonces,
  waiters,
} from './store';

export function startSweepers(): void {
  // Keep the bookkeeping maps from growing forever.
  setInterval(() => {
    const now = Date.now();
    sweepRateBuckets(now);
    for (const [key, seenAt] of seenNonces) {
      if (seenAt + NONCE_RETENTION_MS < now) {
        seenNonces.delete(key);
      }
    }
  }, RATE_WINDOW_MS).unref();

  // TTL sweeper.
  setInterval(() => {
    const now = Date.now();
    for (const [id, blob] of blobs) {
      if (blob.expiresAt <= now) {
        deleteBlob(id);
      }
    }
    for (const [code, rec] of pairingCodes) {
      if (rec.expiresAt <= now) {
        pairingCodes.delete(code);
      }
    }
    let devicesDirty = false;
    for (const [id, device] of devices) {
      if (
        device.lastSeen + DEVICE_STALE_MS <= now &&
        !pendingBlobs.has(id) &&
        !waiters.has(id) &&
        !isPushable(device)
      ) {
        devices.delete(id);
        devicesDirty = true;
      }
    }
    if (devicesDirty) persistDevices();
  }, SWEEP_INTERVAL_MS).unref();
}
