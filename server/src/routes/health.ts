import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';

import { DEBUG_TOKEN } from '../config';
import { readJsonBody } from '../http';
import { blobs, devices } from '../store';

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', (c) => c.json({ ok: true }));

  // Browser CSP violation reports (Caddy report-uri). Metadata only, truncated.
  app.post('/v1/csp-report', async (c) => {
    const read = await readJsonBody(c);
    if (read.ok) {
      console.warn(`[csp] ${read.raw.slice(0, 1500)}`);
    }
    return c.body(null, 204);
  });

  // Zero-knowledge debug: device/blob counts and metadata only, never payloads.
  // Disabled unless DEBUG_TOKEN is set; even then the token is required.
  app.get('/v1/debug', (c) => {
    if (!DEBUG_TOKEN) return c.json({ error: 'not found' }, 404);
    const provided = Buffer.from(c.req.header('x-debug-token') ?? '');
    const expected = Buffer.from(DEBUG_TOKEN);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({
      devices: [...devices.entries()].map(([deviceId, device]) => ({
        deviceId,
        platform: device.platform,
        hasPushToken: Boolean(device.pushToken),
        hasWebPush: Boolean(device.pushSubscription),
        registeredAt: device.registeredAt,
        lastSeen: device.lastSeen,
      })),
      blobs: [...blobs.values()].map((b) => ({
        id: b.id,
        to: b.to,
        from: b.from,
        kind: b.kind,
        expiresAt: b.expiresAt,
      })),
    });
  });
}
