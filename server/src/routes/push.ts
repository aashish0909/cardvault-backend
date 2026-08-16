import type { Hono } from 'hono';

import { authenticatedDevice, unauthorized } from '../auth';
import { isPushable, touchDevice } from '../store';
import { pushToDevice, vapidKeys } from '../push';

export function registerPushRoutes(app: Hono): void {
  // VAPID public key for web push subscription.
  app.get('/v1/push/vapid', (c) => c.json({ publicKey: vapidKeys.publicKey }));

  // Send a test OS banner to this device so the user can confirm lock-screen
  // delivery without waiting for a friend request.
  app.post('/v1/push/test', async (c) => {
    const device = authenticatedDevice(c, '');
    if (!device) return unauthorized(c);
    const deviceId = c.req.header('x-cv-device');
    if (deviceId) touchDevice(deviceId);
    if (!isPushable(device)) {
      return c.json({ error: 'no push subscription on this device' }, 400);
    }
    const ok = await pushToDevice(device, 'push-test');
    if (!ok) return c.json({ error: 'push service rejected the notification' }, 502);
    return c.json({ ok: true });
  });
}
