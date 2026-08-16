// CardVault relay - zero-knowledge blob mailbox.
//
// What this server DOES:
//   - registers device push tokens / web-push subscriptions (persisted on disk
//     so a restart can still ping phones)
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

import { HOSTNAME, PORT, TRUST_PROXY, VAPID_SUBJECT } from './config';
import { createApp } from './http';
import { startSweepers } from './jobs';
import { DEVICES_FILE, loadDevices, persistDevices } from './persist';
import { vapidFromEnv } from './push';
import { registerRoutes } from './routes';

if (!vapidFromEnv && (process.env.HOST === '127.0.0.1' || process.env.NODE_ENV === 'production')) {
  console.warn(
    '[vapid] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are unset; file-based keys are for local dev only'
  );
}
loadDevices();
console.log(`[devices] persist path ${DEVICES_FILE} vapidSubject=${VAPID_SUBJECT}`);

const app = createApp();
registerRoutes(app);
startSweepers();

serve({ fetch: app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  console.log(`cardvault-relay listening on ${info.family} ${info.address}:${info.port}`);
  console.log(`[net] TRUST_PROXY=${TRUST_PROXY ? '1' : '0'} HOST=${HOSTNAME}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    persistDevices();
    process.exit(0);
  });
}
