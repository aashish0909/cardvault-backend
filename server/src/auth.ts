import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import nacl from 'tweetnacl';

import { DEVICE_ID_RE, SIGN_VERSION, TIMESTAMP_TOLERANCE_MS } from './config';
import { devices, seenNonces } from './store';
import type { DeviceRecord } from './types';

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a device-bound Ed25519 request signature against pubHex.
 * Covers: header shape, timestamp window, single-use nonce, signature over
 * `SIGN_VERSION \n METHOD \n path?query \n ts \n nonce \n sha256(body)`.
 */
export function verifySigned(c: Context, rawBody: string, pubHex: string): boolean {
  const deviceId = c.req.header('x-cv-device');
  const ts = c.req.header('x-cv-timestamp');
  const nonce = c.req.header('x-cv-nonce');
  const sig = c.req.header('x-cv-signature');
  if (!deviceId || !ts || !nonce || !sig) return false;
  if (!/^[0-9]{10,15}$/.test(ts) || !/^[0-9a-f]{32}$/i.test(nonce)) return false;
  if (Math.abs(Date.now() - Number(ts)) > TIMESTAMP_TOLERANCE_MS) return false;
  const url = new URL(c.req.url);
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const msg = new TextEncoder().encode(
    [SIGN_VERSION, c.req.method.toUpperCase(), url.pathname + url.search, ts, nonce, bodyHash].join(
      '\n'
    )
  );
  const sigBytes = Buffer.from(sig, 'base64');
  if (sigBytes.length !== 64) return false;
  const pub = hexToBytes(pubHex);
  if (!pub) return false;
  if (!nacl.sign.detached.verify(msg, sigBytes, pub)) return false;
  // Signature is valid; now enforce single use of this nonce.
  const nonceKey = `${deviceId}:${nonce.toLowerCase()}`;
  if (seenNonces.has(nonceKey)) return false;
  seenNonces.set(nonceKey, Date.now());
  return true;
}

export const unauthorized = (c: Context) => c.json({ error: 'unauthorized' }, 401);

/** Device that owns this request per the signature, or null. */
export function authenticatedDevice(c: Context, rawBody: string): DeviceRecord | null {
  const deviceId = c.req.header('x-cv-device');
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return null;
  const device = devices.get(deviceId);
  if (!device) return null;
  if (!verifySigned(c, rawBody, device.signPub)) return null;
  return device;
}
