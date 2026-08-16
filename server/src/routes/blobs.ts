import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';

import {
  DEFAULT_TTL_MS,
  DEVICE_ID_RE,
  LONG_POLL_TIMEOUT_MS,
  MAX_BLOBS_PER_DEVICE,
  MAX_PAYLOAD_BYTES,
  MAX_TTL_MS,
} from '../config';
import { unauthorized, verifySigned } from '../auth';
import { clientIp, isBodyObject, readJsonBody } from '../http';
import { pushToDevice } from '../push';
import {
  addWaiter,
  blobs,
  deleteBlob,
  devices,
  incPending,
  pendingBlobs,
  removeWaiter,
  touchDevice,
  wakeWaiters,
} from '../store';
import type { BlobRecord } from '../types';

export function registerBlobRoutes(app: Hono): void {
  // Deposit an encrypted blob for a recipient device. The deposit must be
  // signed by the sender's registered identity key.
  app.post('/v1/blobs', async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return c.json({ error: 'could not read request body' }, read.status);
    const body = read.json;
    if (
      !isBodyObject(body) ||
      typeof body.to !== 'string' ||
      !DEVICE_ID_RE.test(body.to) ||
      typeof body.from !== 'string' ||
      !DEVICE_ID_RE.test(body.from) ||
      typeof body.kind !== 'string' ||
      (body.kind.length === 0 || body.kind.length > 48) ||
      typeof body.payload !== 'string'
    ) {
      return c.json({ error: 'expected { to, from, kind, payload }' }, 400);
    }
    if (body.payload.length > MAX_PAYLOAD_BYTES) {
      return c.json({ error: 'payload too large' }, 413);
    }
    const sender = devices.get(body.from);
    if (!sender) {
      return unauthorized(c);
    }
    if (c.req.header('x-cv-device') !== body.from || !verifySigned(c, read.raw, sender.signPub)) {
      return unauthorized(c);
    }
    touchDevice(body.from);
    // Hold the blob even if the recipient has not re-registered yet (relay
    // restarts wipe in-memory device records). They pick it up on next poll.

    const ttl =
      typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0
        ? Math.min(body.ttlSeconds * 1000, MAX_TTL_MS)
        : DEFAULT_TTL_MS;

    if ((pendingBlobs.get(body.to) ?? 0) >= MAX_BLOBS_PER_DEVICE) {
      return c.json({ error: 'recipient inbox is full' }, 429);
    }

    const now = Date.now();
    const record: BlobRecord = {
      id: randomUUID(),
      to: body.to,
      from: body.from,
      kind: body.kind,
      payload: body.payload,
      createdAt: now,
      expiresAt: now + ttl,
    };
    blobs.set(record.id, record);
    incPending(body.to);
    console.log(
      `[deposit] kind=${body.kind} from=${body.from} to=${body.to} id=${record.id} ttl=${Math.round(ttl / 1000)}s`
    );
    // Always ping via push. A live long-poll still gets the blob instantly, but
    // iOS PWAs often look "connected" for ~25s after the user leaves the app
    // (zombie waiter), and skipping push in that window drops the lock-screen
    // banner. Foreground clients already show an in-app toast; a duplicate OS
    // banner is better than a missed OTP request.
    wakeWaiters(body.to);
    const recipient = devices.get(body.to);
    if (recipient) void pushToDevice(recipient, body.kind);
    return c.json({ id: record.id, expiresAt: record.expiresAt }, 201);
  });

  // Pick up all pending blobs for a device. Pickup is destructive: returned
  // blobs are deleted from the relay immediately. With ?wait=1 the request
  // hangs until a blob lands (long-poll) so clients get near-instant delivery
  // without push notifications. Only the device's registered key may pick up.
  app.get('/v1/blobs', async (c) => {
    const deviceId = c.req.query('deviceId');
    if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
      return c.json({ error: 'missing deviceId query param' }, 400);
    }
    const device = devices.get(deviceId);
    if (!device) {
      return unauthorized(c);
    }
    if (c.req.header('x-cv-device') !== deviceId || !verifySigned(c, '', device.signPub)) {
      return unauthorized(c);
    }
    touchDevice(deviceId);
    const take = (): BlobRecord[] => {
      const now = Date.now();
      const mine: BlobRecord[] = [];
      for (const blob of blobs.values()) {
        if (blob.to === deviceId && blob.expiresAt > now) {
          mine.push(blob);
        }
      }
      for (const blob of mine) {
        deleteBlob(blob.id);
      }
      if (mine.length > 0) {
        console.log(
          `[pickup] deviceId=${deviceId} count=${mine.length} kinds=${mine.map((b) => b.kind).join(',')}`
        );
      }
      return mine;
    };

    const immediate = take();
    if (immediate.length > 0 || c.req.query('wait') !== '1') {
      return c.json({ blobs: immediate });
    }

    // Long-poll: register a waiter, re-check for races, then hold the request.
    const ip = clientIp(c);
    const signal = c.req.raw.signal;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wake: () => void = () => {};
    let queued = false;
    const held = new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (hasBlob: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        removeWaiter(deviceId, wake);
        signal.removeEventListener('abort', abort);
        resolve(hasBlob);
      };
      const abort = () => finish(false);
      wake = () => finish(true);
      timer = setTimeout(() => finish(false), LONG_POLL_TIMEOUT_MS);
      queued = addWaiter(deviceId, ip, wake);
      if (!queued) {
        finish(false);
        return;
      }
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    if (!queued) {
      return c.json({ error: 'too many waiting pickups' }, 503);
    }
    const raced = take();
    if (raced.length > 0) {
      wake();
      return c.json({ blobs: raced });
    }
    const hasBlob = await held;
    if (!hasBlob) {
      return c.body(null, 408);
    }
    return c.json({ blobs: take() });
  });

  // Explicit delete (e.g. sender revoking before pickup). Only the blob's
  // sender or its recipient may delete it.
  app.delete('/v1/blobs/:id', (c) => {
    const deviceId = c.req.header('x-cv-device');
    if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return unauthorized(c);
    const device = devices.get(deviceId);
    if (!device || !verifySigned(c, '', device.signPub)) return unauthorized(c);
    touchDevice(deviceId);
    const id = c.req.param('id');
    const blob = blobs.get(id);
    if (!blob) return c.body(null, 204);
    if (blob.to !== deviceId && blob.from !== deviceId) {
      return c.json({ error: 'not your blob' }, 403);
    }
    deleteBlob(id);
    return c.body(null, 204);
  });
}
