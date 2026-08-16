import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEVICE_ID_RE, SIGN_PUB_RE } from './config';
import { devices } from './store';
import type { PushSubscriptionRecord } from './types';

export const VAPID_FILE = new URL('../vapid.json', import.meta.url).pathname;
// Device registrations (including web-push subscriptions) survive relay
// restarts. Blobs stay in-memory: they are short-lived mail, not an account.
export const STATE_DIR = process.env.STATE_DIRECTORY || process.env.STATE_DIR || dirname(VAPID_FILE);
export const DEVICES_FILE = join(STATE_DIR, 'devices.json');

export function persistDevices(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const rows = [...devices.entries()].map(([deviceId, d]) => ({
      deviceId,
      signPub: d.signPub,
      pushToken: d.pushToken,
      pushSubscription: d.pushSubscription,
      platform: d.platform,
      registeredAt: d.registeredAt,
      lastSeen: d.lastSeen,
    }));
    const tmp = `${DEVICES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    renameSync(tmp, DEVICES_FILE);
  } catch (err) {
    console.error(`[devices] persist failed: ${(err as Error).message}`);
  }
}

export function loadDevices(): void {
  try {
    if (!existsSync(DEVICES_FILE)) return;
    const raw = JSON.parse(readFileSync(DEVICES_FILE, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return;
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.deviceId !== 'string' || !DEVICE_ID_RE.test(r.deviceId)) continue;
      if (typeof r.signPub !== 'string' || !SIGN_PUB_RE.test(r.signPub)) continue;
      if (r.platform !== 'ios' && r.platform !== 'android' && r.platform !== 'web') continue;
      let sub: PushSubscriptionRecord | null = null;
      if (r.pushSubscription && typeof r.pushSubscription === 'object') {
        const s = r.pushSubscription as Record<string, unknown>;
        const keys = s.keys as Record<string, unknown> | undefined;
        if (
          typeof s.endpoint === 'string' &&
          keys &&
          typeof keys.p256dh === 'string' &&
          typeof keys.auth === 'string'
        ) {
          sub = {
            endpoint: s.endpoint,
            keys: { p256dh: keys.p256dh, auth: keys.auth },
          };
        }
      }
      devices.set(r.deviceId, {
        signPub: r.signPub.toLowerCase(),
        pushToken: typeof r.pushToken === 'string' ? r.pushToken : '',
        pushSubscription: sub,
        platform: r.platform,
        registeredAt: typeof r.registeredAt === 'number' ? r.registeredAt : Date.now(),
        lastSeen: typeof r.lastSeen === 'number' ? r.lastSeen : Date.now(),
      });
    }
    console.log(`[devices] restored ${devices.size} registration(s) from ${DEVICES_FILE}`);
  } catch (err) {
    console.error(`[devices] load failed: ${(err as Error).message}`);
  }
}
