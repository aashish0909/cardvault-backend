import type { Hono } from 'hono';

import { DEVICE_ID_RE, MAX_DEVICES, SIGN_PUB_RE } from '../config';
import { unauthorized, verifySigned } from '../auth';
import { isBodyObject, readJsonBody } from '../http';
import { persistDevices } from '../persist';
import { devices } from '../store';
import type { PushSubscriptionRecord } from '../types';

export function registerDeviceRoutes(app: Hono): void {
  // Register (or refresh) a device's push token / web push subscription.
  //
  // The first registration binds the device's Ed25519 public key to its
  // deviceId; every later registration must be signed by that same key, so a
  // stolen deviceId alone cannot hijack the push registration.
  app.post('/v1/devices', async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return c.json({ error: 'could not read request body' }, read.status);
    const body = read.json;
    if (
      !isBodyObject(body) ||
      typeof body.deviceId !== 'string' ||
      !DEVICE_ID_RE.test(body.deviceId) ||
      typeof body.pushToken !== 'string' ||
      body.pushToken.length > 512 ||
      (body.platform !== 'ios' && body.platform !== 'android' && body.platform !== 'web') ||
      typeof body.signPub !== 'string' ||
      !SIGN_PUB_RE.test(body.signPub)
    ) {
      return c.json({ error: 'expected { deviceId, pushToken, platform, signPub }' }, 400);
    }
    const rawSub = body.pushSubscription as PushSubscriptionRecord | null | undefined;
    if (rawSub !== undefined && rawSub !== null) {
      if (
        typeof rawSub.endpoint !== 'string' ||
        rawSub.endpoint.length > 2048 ||
        !rawSub.keys ||
        typeof rawSub.keys.p256dh !== 'string' ||
        rawSub.keys.p256dh.length > 512 ||
        typeof rawSub.keys.auth !== 'string' ||
        rawSub.keys.auth.length > 512
      ) {
        return c.json(
          { error: 'pushSubscription must be { endpoint, keys: { p256dh, auth } }' },
          400
        );
      }
    }
    const signPub = body.signPub.toLowerCase();
    const existing = devices.get(body.deviceId);
    if (existing && existing.signPub !== signPub) {
      return c.json({ error: 'device is registered with a different signing key' }, 403);
    }
    if (!existing && devices.size >= MAX_DEVICES) {
      return c.json({ error: 'relay is at capacity' }, 503);
    }
    // Proof of possession: the signature must verify against the submitted key.
    if (!verifySigned(c, read.raw, signPub)) {
      return unauthorized(c);
    }
    devices.set(body.deviceId, {
      signPub,
      pushToken: body.pushToken || existing?.pushToken || '',
      pushSubscription: rawSub !== undefined ? rawSub : existing?.pushSubscription ?? null,
      platform: body.platform,
      registeredAt: existing?.registeredAt ?? Date.now(),
      lastSeen: Date.now(),
    });
    persistDevices();
    const device = devices.get(body.deviceId)!;
    console.log(
      `[device] registered id=${body.deviceId} platform=${body.platform} ` +
        `expo=${Boolean(device.pushToken)} web=${Boolean(device.pushSubscription)}`
    );
    return c.body(null, 204);
  });
}
