export const MAX_PAYLOAD_BYTES = 64 * 1024; // encrypted blobs are small; 64 KB is generous
export const MAX_BODY_BYTES = 128 * 1024; // hard cap on any request body (memory DoS)
export const MAX_BLOBS_PER_DEVICE = 200; // inbox cap per recipient (memory exhaustion)
export const MAX_DEVICES = 10_000; // total registered devices cap
export const DEVICE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // drop unused *non-push* registrations after 7d
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
export const MAX_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const LONG_POLL_TIMEOUT_MS = 25 * 1000; // how long a waiting pickup may hang
export const MAX_WAITERS = 2_000;
export const MAX_WAITERS_PER_IP = 40;

// Request signing: Ed25519 detached signatures over a canonical request
// string. Timestamps bound replay to a small window; nonces are single-use
// within that window.
export const SIGN_VERSION = 'cardvault-req-v1';
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
export const NONCE_RETENTION_MS = TIMESTAMP_TOLERANCE_MS * 2;

// Device ids are client-generated UUIDs; keep the charset tight so they are
// safe as map keys, log lines, and canonical-string components.
export const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const SIGN_PUB_RE = /^[0-9a-f]{64}$/i;

// Short pairing codes: an 8-char lookup key that resolves to the (public)
// pairing payload { v, deviceId, name, pub } - the same data the QR holds.
// No ambiguous characters (0/O, 1/I/L, 8/B). Codes are short-lived so they
// behave like OTPs: refresh on demand, expire within minutes.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

// Only trust X-Forwarded-For when we sit behind our own reverse proxy
// (Caddy on loopback). Otherwise the socket address is the client IP, and
// spoofed forwarding headers are ignored.
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Unset in production. When set, GET /v1/debug requires this bearer token.
export const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

// CORS is only granted to allowlisted browser origins (the web app). Native
// clients (react-native fetch) send no Origin header and are unaffected.
export const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const RATE_WINDOW_MS = 60 * 1000;
export const RATE_LIMITS: Record<string, number> = {
  'GET /health': 240,
  'POST /v1/codes': 20,
  'GET /v1/codes/:code': 120,
  'POST /v1/blobs': 180,
  'GET /v1/blobs': 900,
  'DELETE /v1/blobs/:id': 300,
  'POST /v1/devices': 120,
  'GET /v1/push/vapid': 120,
  'POST /v1/push/test': 30,
  'POST /v1/csp-report': 30,
};

// Apple rejects VAPID JWTs whose `sub` is not a real https:/mailto: contact
// (mailto:…@cardvault.local returns 403 and the lock-screen banner never fires).
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://vault.betterstatement.com';
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export const PORT = Number(process.env.PORT ?? 8787);
// Default 0.0.0.0 keeps LAN dev (physical devices through Metro) working;
// production units set HOST=127.0.0.1 so the relay is only reachable via the
// TLS-terminating reverse proxy.
export const HOSTNAME = process.env.HOST ?? '0.0.0.0';
