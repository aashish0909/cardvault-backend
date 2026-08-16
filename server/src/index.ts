// CardVault relay - zero-knowledge blob mailbox.
//
// What this server DOES:
//   - registers device push tokens (so the app can be pinged)
//   - holds opaque, end-to-end encrypted blobs addressed to a device
//   - hands blobs over on pickup and deletes them immediately
//   - expires anything not picked up within its TTL
//
// What this server NEVER sees: card numbers, CVVs, OTPs, or keys.
// Payloads are encrypted on the sender's device and decrypted only on the
// recipient's device. This server treats `payload` as an opaque string.
//
// Every state-changing or mailbox-touching endpoint requires a device-bound
// Ed25519 request signature (x-cv-* headers). The signing seed is derived
// deterministically on the device from its X25519 identity secret, and the
// resulting public key is bound to the deviceId at first registration - so
// only the device that owns an identity may register it, pick up its mail,
// deposit blobs in its name, or delete its blobs. Public endpoints (pairing
// code resolution, VAPID key, health) stay open but rate-limited.

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import webpush from 'web-push';

const MAX_PAYLOAD_BYTES = 64 * 1024; // encrypted blobs are small; 64 KB is generous
const MAX_BODY_BYTES = 128 * 1024; // hard cap on any request body (memory DoS)
const MAX_BLOBS_PER_DEVICE = 200; // inbox cap per recipient (memory exhaustion)
const MAX_DEVICES = 10_000; // total registered devices cap
const DEVICE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // drop unused registrations after 7d
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const MAX_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
const SWEEP_INTERVAL_MS = 60 * 1000;
const LONG_POLL_TIMEOUT_MS = 25 * 1000; // how long a waiting pickup may hang
const MAX_WAITERS = 2_000;
const MAX_WAITERS_PER_IP = 40;

// Request signing: Ed25519 detached signatures over a canonical request
// string. Timestamps bound replay to a small window; nonces are single-use
// within that window.
const SIGN_VERSION = 'cardvault-req-v1';
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const NONCE_RETENTION_MS = TIMESTAMP_TOLERANCE_MS * 2;

// Device ids are client-generated UUIDs; keep the charset tight so they are
// safe as map keys, log lines, and canonical-string components.
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SIGN_PUB_RE = /^[0-9a-f]{64}$/i;

// Short pairing codes: an 8-char lookup key that resolves to the (public)
// pairing payload { v, deviceId, name, pub } - the same data the QR holds.
// No ambiguous characters (0/O, 1/I/L, 8/B). Codes are short-lived so they
// behave like OTPs: refresh on demand, expire within minutes.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

// Only trust X-Forwarded-For when we sit behind our own reverse proxy
// (Caddy on loopback). Otherwise the socket address is the client IP, and
// spoofed forwarding headers are ignored.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Unset in production. When set, GET /v1/debug requires this bearer token.
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

interface DeviceRecord {
  signPub: string; // Ed25519 public key (hex) that owns this deviceId
  pushToken: string;
  pushSubscription: PushSubscriptionRecord | null;
  platform: 'ios' | 'android' | 'web';
  registeredAt: number;
  lastSeen: number;
}

interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface BlobRecord {
  id: string;
  to: string;
  from: string;
  kind: string; // e.g. "pair-request", "card-share", "otp-request", "otp-response"
  payload: string; // opaque E2E-encrypted blob (base64)
  createdAt: number;
  expiresAt: number;
}

interface PairingCodeRecord {
  code: string;
  payload: { v: number; deviceId: string; name: string; pub: string };
  expiresAt: number;
}

const devices = new Map<string, DeviceRecord>();
const blobs = new Map<string, BlobRecord>();
const pairingCodes = new Map<string, PairingCodeRecord>();

// Live blob count per recipient (mirrors `to` fields in `blobs`) so the
// per-inbox cap is O(1) to enforce.
const pendingBlobs = new Map<string, number>();

// Single-use request nonces: `${deviceId}:${nonce}` -> seen at (ms).
const seenNonces = new Map<string, number>();

// Long-poll waiters: deviceId -> callbacks held in pending GET /v1/blobs.
// Deposits wake them so pickups return the moment a blob lands.
interface Waiter {
  wake: () => void;
  ip: string;
}
const waiters = new Map<string, Waiter[]>();
const waiterCountByIp = new Map<string, number>();

function waiterTotal(): number {
  let n = 0;
  for (const list of waiters.values()) n += list.length;
  return n;
}

function addWaiter(deviceId: string, ip: string, wake: () => void): boolean {
  if (waiterTotal() >= MAX_WAITERS) return false;
  if ((waiterCountByIp.get(ip) ?? 0) >= MAX_WAITERS_PER_IP) return false;
  const list = waiters.get(deviceId) ?? [];
  list.push({ wake, ip });
  waiters.set(deviceId, list);
  waiterCountByIp.set(ip, (waiterCountByIp.get(ip) ?? 0) + 1);
  return true;
}

function removeWaiter(deviceId: string, wake: () => void): void {
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

function wakeWaiters(deviceId: string): boolean {
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

function touchDevice(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device) device.lastSeen = Date.now();
}

function randomPairingCode(): string {
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

// --- Web Push (VAPID) ------------------------------------------------------
// Keys are pinned via env for stability; otherwise they are generated once,
// persisted to vapid.json (0600), and reused on restart so stored
// subscriptions keep working. The public key is served to browsers so they
// can subscribe.
const VAPID_SUBJECT = 'mailto:relay@cardvault.local';
const VAPID_FILE = new URL('../vapid.json', import.meta.url).pathname;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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

const vapidFromEnv = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const vapidKeys = loadVapidKeys();
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
if (!vapidFromEnv && (process.env.HOST === '127.0.0.1' || process.env.NODE_ENV === 'production')) {
  console.warn(
    '[vapid] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are unset; file-based keys are for local dev only'
  );
}

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
};

async function pushToDevice(device: DeviceRecord, kind: string): Promise<void> {
  const text = PUSH_TEXT[kind] ?? {
    title: 'CardVault',
    body: 'New activity - open the app to review.',
  };
  if (text === null) return;
  if (device.platform !== 'web') {
    if (!device.pushToken) return;
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
        if (result.data.details?.error === 'DeviceNotRegistered') device.pushToken = '';
        throw new Error(result.data.message ?? 'Expo push rejected');
      }
      console.log(`[push] platform=${device.platform} kind=${kind} delivered`);
    } catch (err) {
      console.error(`[push] platform=${device.platform} kind=${kind} failed: ${(err as Error).message}`);
    }
    return;
  }
  if (!device.pushSubscription) return;
  try {
    await webpush.sendNotification(device.pushSubscription, JSON.stringify(text), {
      TTL: 60 * 60, // 1 h: long enough for the owner to return, no longer
    });
    console.log(`[push] kind=${kind} delivered`);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) {
      device.pushSubscription = null; // push service dropped the subscription
    } else {
      console.error(`[push] kind=${kind} failed: ${(err as Error).message}`);
    }
  }
}

// --- helpers ---------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Read (capped) and parse a JSON request body. Returns raw text too, so the
 *  same bytes feed signature verification - never re-read the stream. */
type BodyRead = { ok: true; raw: string; json: unknown } | { ok: false; status: 400 | 413 };

async function readJsonBody(c: Context): Promise<BodyRead> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413 };
  let raw = '';
  const bodyStream = c.req.raw.body;
  if (bodyStream) {
    const reader = bodyStream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (raw.length > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return { ok: false, status: 413 };
        }
      }
      raw += dec.decode();
    } catch {
      return { ok: false, status: 400 };
    }
  }
  try {
    return { ok: true, raw, json: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function isBodyObject(json: unknown): json is Record<string, unknown> {
  return typeof json === 'object' && json !== null;
}

/**
 * Verify a device-bound Ed25519 request signature against pubHex.
 * Covers: header shape, timestamp window, single-use nonce, signature over
 * `SIGN_VERSION \n METHOD \n path?query \n ts \n nonce \n sha256(body)`.
 */
function verifySigned(c: Context, rawBody: string, pubHex: string): boolean {
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

const unauthorized = (c: Context) => c.json({ error: 'unauthorized' }, 401);

/** Device that owns this request per the signature, or null. */
function authenticatedDevice(c: Context, rawBody: string): DeviceRecord | null {
  const deviceId = c.req.header('x-cv-device');
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return null;
  const device = devices.get(deviceId);
  if (!device) return null;
  if (!verifySigned(c, rawBody, device.signPub)) return null;
  return device;
}

function incPending(to: string): void {
  pendingBlobs.set(to, (pendingBlobs.get(to) ?? 0) + 1);
}

function decPending(to: string): void {
  const next = (pendingBlobs.get(to) ?? 1) - 1;
  if (next > 0) pendingBlobs.set(to, next);
  else pendingBlobs.delete(to);
}

function deleteBlob(id: string): boolean {
  const blob = blobs.get(id);
  if (!blob) return false;
  blobs.delete(id);
  decPending(blob.to);
  return true;
}

const app = new Hono();

// --- network hardening ---------------------------------------------------
// CORS is only granted to allowlisted browser origins (the web app). Native
// clients (react-native fetch) send no Origin header and are unaffected.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Simple per-IP sliding-window rate limits.
interface Bucket {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, Bucket>();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS: Record<string, number> = {
  'GET /health': 240,
  'POST /v1/codes': 20,
  'GET /v1/codes/:code': 120,
  'POST /v1/blobs': 180,
  'GET /v1/blobs': 900,
  'DELETE /v1/blobs/:id': 300,
  'POST /v1/devices': 120,
  'GET /v1/push/vapid': 120,
  'POST /v1/csp-report': 30,
};

function isPlausibleIp(value: string): boolean {
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ||
    (value.includes(':') && value.length <= 45 && !/[\s,]/.test(value))
  );
}

function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd && isPlausibleIp(fwd)) return fwd;
    const cf = c.req.header('cf-connecting-ip')?.trim();
    if (cf && isPlausibleIp(cf)) return cf;
  }
  try {
    const info = getConnInfo(c);
    if (info.remote?.address) return info.remote.address;
  } catch {
    // adapter did not expose conn info
  }
  // Last resort: a shared bucket. Prefer being too strict over trusting a
  // spoofable forwarding header when TRUST_PROXY is off.
  return 'unknown';
}

app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && CORS_ORIGINS.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'content-type, x-cv-device, x-cv-timestamp, x-cv-nonce, x-cv-signature'
    );
    c.header('Access-Control-Max-Age', '600');
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return c.json({ error: 'request body too large' }, 413);
  }
  const pathname = new URL(c.req.url).pathname;
  const route = `${c.req.method} ${
    /^\/v1\/codes\/[A-Z0-9]{8}$/i.test(pathname)
      ? '/v1/codes/:code'
      : pathname.replace(/\/[0-9a-f-]+$/i, '/:id')
  }`;
  const limit = RATE_LIMITS[route];
  if (limit !== undefined) {
    const ip = clientIp(c);
    const now = Date.now();
    const key = `${route}|${ip}`;
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.windowStart + RATE_WINDOW_MS < now) {
      rateBuckets.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count += 1;
      if (bucket.count > limit) {
        return c.json({ error: 'rate limit exceeded, slow down' }, 429);
      }
    }
  }
  await next();
});

// Keep the bookkeeping maps from growing forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.windowStart + RATE_WINDOW_MS < now) {
      rateBuckets.delete(key);
    }
  }
  for (const [key, seenAt] of seenNonces) {
    if (seenAt + NONCE_RETENTION_MS < now) {
      seenNonces.delete(key);
    }
  }
}, RATE_WINDOW_MS).unref();

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
  const device = devices.get(body.deviceId)!;
  console.log(
    `[device] registered id=${body.deviceId} platform=${body.platform} ` +
      `expo=${Boolean(device.pushToken)} web=${Boolean(device.pushSubscription)}`
  );
  return c.body(null, 204);
});

// VAPID public key for web push subscription.
app.get('/v1/push/vapid', (c) => c.json({ publicKey: vapidKeys.publicKey }));

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
  if (!devices.has(body.to)) {
    return c.json({ error: 'recipient is not registered' }, 404);
  }

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
  if (wakeWaiters(body.to)) {
    // Recipient is long-polling; no push needed.
  } else {
    // Recipient is not long-polling (app closed/locked): ping them via push.
    const recipient = devices.get(body.to);
    if (recipient) void pushToDevice(recipient, body.kind);
  }
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
  if (!blob) return c.body(null, 404);
  if (blob.to !== deviceId && blob.from !== deviceId) {
    return c.json({ error: 'not your blob' }, 403);
  }
  deleteBlob(id);
  return c.body(null, 204);
});

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
  for (const [id, device] of devices) {
    if (
      device.lastSeen + DEVICE_STALE_MS <= now &&
      !pendingBlobs.has(id) &&
      !waiters.has(id)
    ) {
      devices.delete(id);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

const port = Number(process.env.PORT ?? 8787);
// Default 0.0.0.0 keeps LAN dev (physical devices through Metro) working;
// production units set HOST=127.0.0.1 so the relay is only reachable via the
// TLS-terminating reverse proxy.
const hostname = process.env.HOST ?? '0.0.0.0';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`cardvault-relay listening on ${info.family} ${info.address}:${info.port}`);
  console.log(`[net] TRUST_PROXY=${TRUST_PROXY ? '1' : '0'} HOST=${hostname}`);
});
