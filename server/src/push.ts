import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

import { EXPO_PUSH_URL, VAPID_SUBJECT } from './config';
import { persistDevices, VAPID_FILE } from './persist';
import type { DeviceRecord } from './types';

function loadVapidKeys(): { publicKey: string; privateKey: string } {
  const fromEnv =
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : null;
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(VAPID_FILE)) {
      const saved = JSON.parse(readFileSync(VAPID_FILE, 'utf8')) as {
        publicKey: string;
        privateKey: string;
      };
      if (saved.publicKey && saved.privateKey) return saved;
    }
  } catch {
    // fall through and regenerate
  }
  const generated = webpush.generateVAPIDKeys();
  try {
    writeFileSync(VAPID_FILE, JSON.stringify(generated, null, 2), { mode: 0o600 });
  } catch {
    // ephemeral (e.g. serverless): keys last for this process only
  }
  console.log(`[vapid] generated new keys (public: ${generated.publicKey})`);
  return generated;
}

export const vapidFromEnv = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidKeys = loadVapidKeys();
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

// Push copy for the kinds that warrant waking the user. Everything here is
// public metadata (kind is visible to the relay anyway); the payload itself is
// E2E-encrypted and never touches this server.
const PUSH_TEXT: Record<string, { title: string; body: string } | null> = {
  'pair-request': { title: 'Pairing request', body: 'A new device wants to pair with you.' },
  'pair-accept': { title: 'Pairing accepted', body: 'A pairing request was accepted.' },
  'card-share': { title: 'New shared card', body: 'A friend shared a card with you.' },
  'card-unshare': { title: 'Card unshared', body: 'A shared card was removed.' },
  'details-request': { title: 'Details request', body: 'A friend wants your card details.' },
  'details-approve': { title: 'Details ready', body: 'Your card details are ready to view.' },
  'details-deny': { title: 'Request denied', body: 'A details request was denied.' },
  'otp-request': { title: 'OTP request', body: 'A friend is requesting an OTP.' },
  'otp-approve': { title: 'OTP ready', body: 'Your OTP is ready to view.' },
  'otp-deny': { title: 'Request denied', body: 'Your OTP request was denied.' },
  'request-cancel': { title: 'Request cancelled', body: 'A request was cancelled.' },
  'request-revoke': { title: 'Window revoked', body: 'An approved window was revoked.' },
  'name-update': null,
  'push-test': { title: 'CardVault', body: 'Notifications are working on this device.' },
};

function pushHost(device: DeviceRecord): string {
  try {
    return device.pushSubscription ? new URL(device.pushSubscription.endpoint).host : 'expo';
  } catch {
    return 'invalid';
  }
}

/** Returns true when the push service accepted the message. */
export async function pushToDevice(device: DeviceRecord, kind: string): Promise<boolean> {
  const text = PUSH_TEXT[kind] ?? {
    title: 'CardVault',
    body: 'New activity - open the app to review.',
  };
  if (text === null) return false;
  const payload = JSON.stringify({ ...text, kind });
  if (device.platform !== 'web') {
    if (!device.pushToken) {
      console.warn(`[push] platform=${device.platform} kind=${kind} skipped: no expo token`);
      return false;
    }
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: device.pushToken,
          title: text.title,
          body: text.body,
          sound: 'default',
          priority: 'high',
          channelId: 'requests',
          data: { kind },
        }),
      });
      const result = (await res.json().catch(() => null)) as {
        data?: { status?: string; message?: string; details?: { error?: string } };
      } | null;
      if (!res.ok) throw new Error(`Expo push failed: ${res.status}`);
      if (result?.data?.status === 'error') {
        if (result.data.details?.error === 'DeviceNotRegistered') {
          device.pushToken = '';
          persistDevices();
        }
        throw new Error(result.data.message ?? 'Expo push rejected');
      }
      console.log(`[push] platform=${device.platform} kind=${kind} delivered`);
      return true;
    } catch (err) {
      console.error(`[push] platform=${device.platform} kind=${kind} failed: ${(err as Error).message}`);
      return false;
    }
  }
  if (!device.pushSubscription) {
    console.warn(`[push] kind=${kind} skipped: no web-push subscription`);
    return false;
  }
  const host = pushHost(device);
  try {
    await webpush.sendNotification(device.pushSubscription, payload, {
      // Long enough that a briefly-offline phone still gets the banner;
      // OTP/details windows are shorter, so the user still has to open the app.
      TTL: 4 * 60 * 60,
      urgency: 'high',
    });
    console.log(`[push] kind=${kind} host=${host} delivered`);
    return true;
  } catch (err) {
    const webErr = err as { statusCode?: number; body?: string; message?: string };
    const code = webErr.statusCode;
    const body = typeof webErr.body === 'string' ? webErr.body.slice(0, 300) : '';
    if (code === 404 || code === 410) {
      device.pushSubscription = null; // push service dropped the subscription
      persistDevices();
      console.warn(`[push] kind=${kind} host=${host} subscription gone (${code}); cleared`);
    } else {
      console.error(
        `[push] kind=${kind} host=${host} failed: ${webErr.message ?? err} status=${code ?? '?'} body=${body}`
      );
    }
    return false;
  }
}
