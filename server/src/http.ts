import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type Next } from 'hono';

import { CORS_ORIGINS, MAX_BODY_BYTES, RATE_LIMITS, RATE_WINDOW_MS, TRUST_PROXY } from './config';

export type BodyRead = { ok: true; raw: string; json: unknown } | { ok: false; status: 400 | 413 };

/** Read (capped) and parse a JSON request body. Returns raw text too, so the
 *  same bytes feed signature verification - never re-read the stream. */
export async function readJsonBody(c: Context): Promise<BodyRead> {
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

export function isBodyObject(json: unknown): json is Record<string, unknown> {
  return typeof json === 'object' && json !== null;
}

interface Bucket {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, Bucket>();

export function sweepRateBuckets(now = Date.now()): void {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.windowStart + RATE_WINDOW_MS < now) {
      rateBuckets.delete(key);
    }
  }
}

function isPlausibleIp(value: string): boolean {
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ||
    (value.includes(':') && value.length <= 45 && !/[\s,]/.test(value))
  );
}

export function clientIp(c: Context): string {
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

export async function securityMiddleware(c: Context, next: Next) {
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
}

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', securityMiddleware);
  return app;
}
