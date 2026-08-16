// E2E tests for the Phase 2 pairing + sharing path.
//
// Modes:
//   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e.test.ts
//       -> in-process crypto tests (no relay needed)
//
//   ROLE=alice ID_FILE=/tmp/bob.json npx tsx --tsconfig scripts/tsconfig.json scripts/e2e.test.ts
//       -> simulate the scanning side: generates "Bob", sends a pair-request,
//          waits for the accept, then sends a card-share
//
//   ROLE=bob ID_FILE=/tmp/bob.json npx tsx --tsconfig scripts/tsconfig.json scripts/e2e.test.ts
//       -> simulate the scanned side: picks up the request, accepts, waits for
//          the card share
//
// The relay must be running on localhost:8787 for the role modes. The two
// roles communicate ONLY through the relay - a real distributed round trip.

import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import nacl from 'tweetnacl';

import * as SecureStore from 'expo-secure-store';
import { base64Decode, base64Encode, bytesToUtf8, bytesToHex, utf8Bytes } from '../lib/bytes';
import { sealTo, openFrom } from '../lib/e2e';
import { generateIdentity, getIdentity, pairingFingerprint } from '../lib/identity';
import { signRequest, signingPublicKeyHex } from '../lib/reqsig';
import { useRevealStore } from '../lib/reveal';
import {
  handleIncomingBlob,
  pollInbox,
  registerDevice,
  sendBlob,
  IncomingCtx,
} from '../lib/relay';

nacl.setPRNG((x, n) => {
  x.set(randomBytes(n));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID_FILE = process.env.ID_FILE ?? '/tmp/cardvault-bob.json';
const ROLE = process.env.ROLE ?? 'crypto';

function memoryCtx(): {
  ctx: IncomingCtx;
  peers: Map<
    string,
    { id: string; name: string; publicKey: string; direction: string; status: string }
  >;
  shared: Array<{ nickname: string; last4: string }>;
  requests: Map<string, { id: string; kind: string; status: string; cardId: string; peerId: string; amount?: string | null; merchant?: string | null }>;
} {
  const peers = new Map<
    string,
    { id: string; name: string; publicKey: string; direction: string; status: string }
  >();
  const shared: Array<{ nickname: string; last4: string }> = [];
  const requests = new Map<
    string,
    { id: string; kind: string; status: string; cardId: string; peerId: string; amount?: string | null; merchant?: string | null }
  >();
  const ctx: IncomingCtx = {
    getPeer: async (d) => (peers.has(d) ? (peers.get(d) as never) : null),
    upsertPeer: async (p) =>
      peers.set(p.id, {
        id: p.id,
        name: p.name,
        publicKey: p.publicKey,
        direction: p.direction,
        status: p.status,
      }),
    setPeerStatus: async (d, s) => {
      const p = peers.get(d);
      if (p) peers.set(d, { ...p, status: s });
    },
    setPeerName: async (d, name) => {
      const p = peers.get(d);
      if (p) peers.set(d, { ...p, name });
    },
    deletePeer: async (d) => {
      peers.delete(d);
    },
    insertSharedCard: async (s) => {
      shared.push({ nickname: s.nickname, last4: s.last4 });
    },
    removeSharedByOwner: async () => {},
    cancelRequestsForCard: async (peerId, ownerCardId) => {
      for (const r of requests.values()) {
        if (
          r.peerId === peerId &&
          r.cardId === ownerCardId &&
          r.status === 'pending'
        ) {
          requests.set(r.id, { ...r, status: 'cancelled' });
        }
      }
    },
    removeSharedCardsByPeer: async () => {},
    insertRequest: async (r) => {
      const row = {
        id: r.id,
        direction: r.direction,
        kind: r.kind,
        status: r.status,
        cardId: r.cardId,
        peerId: r.peerId,
        amount: r.amount ?? null,
        merchant: r.merchant ?? null,
      };
      requests.set(r.id, row);
      return row as never;
    },
    getRequest: async (d) => (requests.has(d) ? (requests.get(d) as never) : null),
    listRequests: async () => [...requests.values()] as never[],
    setRequestStatus: async (id, status) => {
      const r = requests.get(id);
      if (r) requests.set(id, { ...r, status });
    },
  };
  return { ctx, peers, shared, requests };
}

async function cryptoTests(): Promise<void> {
  const identity = await getIdentity();

  const sealed = await sealTo(
    JSON.stringify({ hello: 'world', symbol: '₹ €' }),
    identity.pubHex
  );
  const opened = await openFrom(sealed);
  assert.deepStrictEqual(JSON.parse(opened), { hello: 'world', symbol: '₹ €' });
  console.log('ok - e2e round trip (incl. unicode)');

  // Flip a byte INSIDE the decoded box (not the outer base64 - flipping a
  // base64 char can produce an invalid char that lenient decoders ignore,
  // which makes the tamper undetected and this test flaky).
  const env = JSON.parse(bytesToUtf8(base64Decode(sealed)));
  const boxBytes = base64Decode(env.box);
  boxBytes[boxBytes.length - 3] ^= 0x01;
  env.box = base64Encode(boxBytes);
  const tampered = base64Encode(utf8Bytes(JSON.stringify(env)));
  await assert.rejects(() => openFrom(tampered));
  console.log('ok - tampered payload rejected');

  // Recipient binding: a message sealed to someone else's public key cannot
  // be opened by us - only the intended recipient's secret key can.
  const randomPub = bytesToHex(nacl.randomBytes(32));
  await assert.rejects(async () => openFrom(await sealTo('secret', randomPub)));
  console.log('ok - recipient-bound: cannot open someone else\'s message');

  // envelope is opaque: no plaintext leaks in the sealed payload
  assert.ok(!sealed.includes('world'));
  console.log('ok - no plaintext in sealed envelope');

  const alice = generateIdentity('Alice');
  const bob = generateIdentity('Bob');
  const ab = await pairingFingerprint(alice.pubHex, bob.pubHex);
  const ba = await pairingFingerprint(bob.pubHex, alice.pubHex);
  assert.equal(ab, ba, 'fingerprint must be order-independent');
  assert.equal(
    await pairingFingerprint(alice.pubHex.toUpperCase(), bob.pubHex),
    ab,
    'fingerprint must ignore hex case'
  );
  assert.match(ab, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.notEqual(await pairingFingerprint(alice.pubHex, randomPub), ab);
  console.log('ok - pairing fingerprint is a shared two-key safety number');

  // Cancel can be delivered before the original request blob. The owner must
  // not be left with a still-pending approve/deny row.
  {
    const me = await getIdentity();
    const { ctx, peers, requests } = memoryCtx();
    const peerId = 'peer-device-1';
    peers.set(peerId, {
      id: peerId,
      name: 'Peer',
      publicKey: me.pubHex,
      direction: 'in',
      status: 'paired',
    });
    const requestId = 'req-cancel-first';
    const cancelPayload = await sealTo(
      JSON.stringify({ requestId, cardId: 'card-1', kind: 'details' }),
      me.pubHex
    );
    const requestPayload = await sealTo(
      JSON.stringify({ requestId, cardId: 'card-1' }),
      me.pubHex
    );
    await handleIncomingBlob(
      { id: 'b1', from: peerId, kind: 'request-cancel', payload: cancelPayload },
      ctx
    );
    assert.equal(requests.get(requestId)?.status, 'cancelled');
    await handleIncomingBlob(
      { id: 'b2', from: peerId, kind: 'details-request', payload: requestPayload },
      ctx
    );
    assert.equal(requests.get(requestId)?.status, 'cancelled');
    console.log('ok - cancel before details-request does not leave a pending request');

    const requestId2 = 'req-then-cancel';
    const requestPayload2 = await sealTo(
      JSON.stringify({ requestId: requestId2, cardId: 'card-1' }),
      me.pubHex
    );
    const cancelPayload2 = await sealTo(
      JSON.stringify({ requestId: requestId2, cardId: 'card-1', kind: 'details' }),
      me.pubHex
    );
    await handleIncomingBlob(
      { id: 'b3', from: peerId, kind: 'details-request', payload: requestPayload2 },
      ctx
    );
    assert.equal(requests.get(requestId2)?.status, 'pending');
    await handleIncomingBlob(
      { id: 'b4', from: peerId, kind: 'request-cancel', payload: cancelPayload2 },
      ctx
    );
    assert.equal(requests.get(requestId2)?.status, 'cancelled');
    console.log('ok - cancel after details-request marks the request cancelled');
  }

  console.log('\nAll e2e crypto tests passed.');
}

async function aliceMode(): Promise<void> {
  const bob = generateIdentity('Bob');
  fs.writeFileSync(ID_FILE, JSON.stringify(bob));
  console.log('ALICE: wrote bob identity file');

  const me = await getIdentity();
  const { ctx, peers, requests } = memoryCtx();
  peers.set(bob.deviceId, {
    id: bob.deviceId,
    name: bob.name,
    publicKey: bob.pubHex,
    direction: 'out',
    status: 'pending',
  });

  await registerDevice();
  const bobBody = JSON.stringify({
    deviceId: bob.deviceId,
    pushToken: '',
    platform: 'ios',
    signPub: signingPublicKeyHex(bob),
  });
  const bobSigned = signRequest(bob, 'POST', '/v1/devices', bobBody);
  await fetch('http://localhost:8787/v1/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bobSigned.headers },
    body: bobSigned.body,
  });

  await sendBlob(
    bob.deviceId,
    'pair-request',
    { v: 1, deviceId: me.deviceId, name: me.name, pub: me.pubHex },
    ctx
  );
  console.log('ALICE: pair-request sent');

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    await pollInbox(ctx);
    if (peers.get(bob.deviceId)?.status === 'paired') {
      console.log('ALICE: paired with Bob');
      await sendBlob(
        bob.deviceId,
        'card-share',
        {
          cardId: 'card-123',
          nickname: 'HDFC Millennia',
          network: 'visa',
          last4: '4242',
          color: '#1A3B8F',
        },
        ctx
      );
      console.log('ALICE: card-share sent');
      break;
    }
  }

  // Wait for Bob's details request, approve it with the full unlock package.
  let detailsApproved = false;
  for (let i = 0; i < 30 && !detailsApproved; i++) {
    await sleep(1000);
    await pollInbox(ctx);
    const req = [...requests.values()].find(
      (r) => r.kind === 'details' && r.status === 'pending'
    );
    if (req) {
      console.log('ALICE: got details request, approving');
      await sendBlob(
        req.peerId,
        'details-approve',
        {
          requestId: req.id,
          cardId: req.cardId,
          details: {
            holderName: 'AASHISH ANAND',
            pan: '4242424242424242',
            expiry: '12/29',
            cvv: '123',
          },
          expiresAt: Date.now() + 15 * 60 * 1000,
        },
        ctx
      );
      detailsApproved = true;
    }
  }
  if (!detailsApproved) {
    console.error('ALICE: timed out waiting for details request');
    process.exit(1);
  }

  // Wait for Bob's OTP request, approve with an OTP.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    await pollInbox(ctx);
    const req = [...requests.values()].find(
      (r) => r.kind === 'otp' && r.status === 'pending'
    );
    if (req) {
      console.log(`ALICE: got OTP request (₹${req.amount} at ${req.merchant}), approving`);
      await sendBlob(
        req.peerId,
        'otp-approve',
        { requestId: req.id, otp: '482913', expiresAt: Date.now() + 10 * 60 * 1000 },
        ctx
      );
      console.log('ALICE_DONE');
      process.exit(0);
    }
  }
  console.error('ALICE: timed out waiting for OTP request');
  process.exit(1);
}

async function bobMode(): Promise<void> {
  for (let i = 0; i < 40 && !fs.existsSync(ID_FILE); i++) {
    await sleep(500);
  }
  const bob = JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
  await SecureStore.setItemAsync('cardvault.identity.v1', JSON.stringify(bob));

  const { ctx, peers, shared, requests } = memoryCtx();
  await registerDevice();
  console.log('BOB: registered');

  let accepted = false;
  let aliceId: string | null = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    await pollInbox(ctx);
    const alice = [...peers.values()].find((p) => p.direction === 'in');
    if (!accepted && alice) {
      console.log(`BOB: got pair-request from ${alice.name}`);
      accepted = true;
      aliceId = alice.id;
      await ctx.setPeerStatus(alice.id, 'paired');
      await sendBlob(alice.id, 'pair-accept', {}, ctx);
      console.log('BOB: accepted');
    }
    if (shared.length > 0) {
      console.log(
        `BOB: got card share "${shared[0].nickname}" (masked: •••• ${shared[0].last4})`
      );
      break;
    }
  }
  if (shared.length === 0) {
    console.error('BOB: timed out waiting for card share');
    process.exit(1);
  }

  // Phase 3: request details, wait for approval, verify the reveal window.
  if (aliceId) {
    const detailsRequestId = nacl.randomBytes(16).join('');
    await sendBlob(
      aliceId,
      'details-request',
      { requestId: detailsRequestId, cardId: 'card-123' },
      ctx
    );
    console.log('BOB: details request sent');
    await ctx.insertRequest({
      id: detailsRequestId,
      direction: 'out',
      peerId: aliceId,
      cardId: 'card-123',
      kind: 'details',
      status: 'pending',
    });
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    await pollInbox(ctx);
    const details = useRevealStore.getState().details['card-123'];
    if (details) {
      assert.strictEqual(details.secrets.pan, '4242424242424242');
      assert.strictEqual(details.secrets.cvv, '123');
      assert.ok(details.expiresAt > Date.now());
      console.log('BOB: details approved - full PAN revealed with 15-min window');

      // Now request an OTP and expect it relayed back.
      const otpRequestId = nacl.randomBytes(16).join('');
      await sendBlob(
        aliceId!,
        'otp-request',
        { requestId: otpRequestId, cardId: 'card-123', amount: '1499', merchant: 'Swiggy' },
        ctx
      );
      console.log('BOB: OTP request sent (₹1499 at Swiggy)');
      await ctx.insertRequest({
        id: otpRequestId,
        direction: 'out',
        peerId: aliceId!,
        cardId: 'card-123',
        kind: 'otp',
        amount: '1499',
        merchant: 'Swiggy',
        status: 'pending',
      });

      for (let j = 0; j < 30; j++) {
        await sleep(1000);
        await pollInbox(ctx);
        const otp = useRevealStore.getState().otp[otpRequestId];
        if (otp) {
          assert.strictEqual(otp.otp, '482913');
          assert.ok(otp.expiresAt > Date.now());
          console.log('BOB: OTP received and decrypted: 482913');
          console.log('BOB_DONE');
          process.exit(0);
        }
      }
      console.error('BOB: timed out waiting for OTP');
      process.exit(1);
    }
  }
  console.error('BOB: timed out waiting for details approval');
  process.exit(1);
}

async function main(): Promise<void> {
  if (ROLE === 'alice') return aliceMode();
  if (ROLE === 'bob') return bobMode();
  return cryptoTests();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
