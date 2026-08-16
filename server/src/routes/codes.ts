import type { Hono } from 'hono';

import { DEVICE_ID_RE, PAIRING_CODE_TTL_MS } from '../config';
import { unauthorized, verifySigned } from '../auth';
import { isBodyObject, readJsonBody } from '../http';
import { devices, pairingCodes, randomPairingCode, touchDevice } from '../store';

export function registerCodeRoutes(app: Hono): void {
  // Create a short-lived pairing code for this device. The relay stores only
  // the public pairing payload (what the QR shows anyway) under a random code.
  app.post('/v1/codes', async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return c.json({ error: 'could not read request body' }, read.status);
    const body = read.json;
    if (
      !isBodyObject(body) ||
      body.v !== 1 ||
      typeof body.deviceId !== 'string' ||
      !DEVICE_ID_RE.test(body.deviceId) ||
      typeof body.name !== 'string' ||
      typeof body.pub !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(body.pub)
    ) {
      return c.json({ error: 'expected { v: 1, deviceId, name, pub }' }, 400);
    }
    const device = devices.get(body.deviceId);
    if (!device) {
      // Only already-registered devices may mint codes.
      return unauthorized(c);
    }
    if (c.req.header('x-cv-device') !== body.deviceId || !verifySigned(c, read.raw, device.signPub)) {
      return unauthorized(c);
    }
    touchDevice(body.deviceId);
    const name = body.name.trim().slice(0, 40) || 'Friend';
    const code = randomPairingCode();
    pairingCodes.set(code, {
      code,
      payload: { v: 1, deviceId: body.deviceId, name, pub: body.pub },
      expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    });
    console.log(`[code] created for device ${body.deviceId}`);
    return c.json({ code }, 201);
  });

  // Resolve a pairing code to its public payload.
  app.get('/v1/codes/:code', (c) => {
    const code = c.req.param('code').toUpperCase();
    const rec = pairingCodes.get(code);
    if (!rec || rec.expiresAt <= Date.now()) {
      pairingCodes.delete(code);
      return c.json({ error: 'code not found or expired' }, 404);
    }
    return c.json(rec.payload);
  });
}
