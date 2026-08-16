// Relay client: device registration, E2E blob delivery, and inbox dispatch.
//
// All payloads are sealed with lib/e2e.ts before touching the relay - the
// server only ever sees opaque base64. `handleIncomingBlob` takes an
// injectable context so the dispatch logic can be tested in Node against the
// real relay without a device (see scripts/e2e.test.ts).

import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';

import { getRelayUrl } from './config';
import { openFrom, sealTo } from './e2e';
import { getIdentity } from './identity';
import { getPushToken, notify } from './notify';
import { signRequest, signingPublicKeyHex } from './reqsig';
import { useRevealStore, DETAILS_WINDOW_MS, OTP_WINDOW_MS } from './reveal';
import * as db from './db';

// Inbox event bus: bumped every time a blob is successfully handled, so
// screens (Friends, Shared) can refresh live instead of only on focus.
interface InboxState {
  eventId: number;
}

export const useInboxStore = create<InboxState>(() => ({ eventId: 0 }));

export function notifyInboxEvent(): void {
  useInboxStore.setState((s) => ({ eventId: s.eventId + 1 }));
}

export interface IncomingCtx {
  getPeer: (deviceId: string) => Promise<db.PeerRow | null>;
  upsertPeer: (p: Omit<db.PeerRow, 'createdAt'>) => Promise<void>;
  setPeerStatus: (deviceId: string, status: db.PeerStatus) => Promise<void>;
  setPeerName: (deviceId: string, name: string) => Promise<void>;
  deletePeer: (deviceId: string) => Promise<void>;
  insertSharedCard: (
    s: Omit<db.SharedCardRow, 'id' | 'createdAt' | 'label'> & {
      label?: string | null;
    }
  ) => Promise<void>;
  removeSharedByOwner: (peerId: string, ownerCardId: string) => Promise<void>;
  cancelRequestsForCard: (peerId: string, ownerCardId: string) => Promise<void>;
  removeSharedCardsByPeer: (peerId: string) => Promise<void>;
  insertRequest: (
    r: Omit<
      db.RequestRow,
      'createdAt' | 'resolvedAt' | 'windowExpiresAt' | 'amount' | 'merchant'
    > & { amount?: string | null; merchant?: string | null }
  ) => Promise<db.RequestRow>;
  getRequest: (id: string) => Promise<db.RequestRow | null>;
  listRequests: () => Promise<db.RequestRow[]>;
  setRequestStatus: (id: string, status: db.RequestStatus, windowExpiresAt?: number | null) => Promise<void>;
}

const defaultCtx: IncomingCtx = {
  getPeer: db.getPeer,
  upsertPeer: db.upsertPeer,
  setPeerStatus: db.setPeerStatus,
  setPeerName: db.setPeerName,
  deletePeer: db.deletePeer,
  insertSharedCard: db.insertSharedCard,
  removeSharedByOwner: db.removeSharedByOwner,
  cancelRequestsForCard: db.cancelRequestsForCard,
  removeSharedCardsByPeer: db.removeSharedCardsByPeer,
  insertRequest: db.insertRequest,
  getRequest: db.getRequest,
  listRequests: db.listRequests,
  setRequestStatus: db.setRequestStatus,
};

export async function registerDevice(): Promise<void> {
  try {
    const identity = await getIdentity();
    const pushToken = await getPushToken();
    const body = JSON.stringify({
      deviceId: identity.deviceId,
      pushToken: pushToken ?? '',
      platform: Platform.OS,
      signPub: signingPublicKeyHex(identity),
    });
    const signed = signRequest(identity, 'POST', '/v1/devices', body);
    await fetch(`${getRelayUrl()}/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
    });
  } catch {
    // Offline is fine; the app retries on next poll cycle.
  }
}

export async function sendBlob(
  toDeviceId: string,
  kind: string,
  payload: object,
  ctx: Pick<IncomingCtx, 'getPeer'> = { getPeer: db.getPeer }
): Promise<void> {
  const identity = await getIdentity();
  const peer = await ctx.getPeer(toDeviceId);
  if (!peer) throw new Error(`No peer record for ${toDeviceId}`);
  const sealed = await sealTo(JSON.stringify(payload), peer.publicKey);
  const body = JSON.stringify({
    to: toDeviceId,
    from: identity.deviceId,
    kind,
    payload: sealed,
  });
  const signed = signRequest(identity, 'POST', '/v1/blobs', body);
  const res = await fetch(`${getRelayUrl()}/v1/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body: signed.body,
  });
  if (res.status === 401) {
    // Key not bound yet (fresh install / relay restart): register and retry once.
    await registerDevice();
    const retry = signRequest(await getIdentity(), 'POST', '/v1/blobs', body);
    const res2 = await fetch(`${getRelayUrl()}/v1/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...retry.headers },
      body: retry.body,
    });
    if (!res2.ok) throw new Error(`Relay deposit failed: ${res2.status}`);
    return;
  }
  if (!res.ok) throw new Error(`Relay deposit failed: ${res.status}`);
}

/** Tell every known peer this device's new display name (best effort). */
export async function sendNameUpdate(
  name: string,
  ctx: Pick<IncomingCtx, 'getPeer'> & { listPeers?: () => Promise<db.PeerRow[]> } = {
    getPeer: db.getPeer,
    listPeers: db.listPeers,
  }
): Promise<void> {
  const peers = await (ctx.listPeers ?? db.listPeers)();
  await Promise.all(
    peers.map((peer) =>
      sendBlob(peer.id, 'name-update', { name }, ctx).catch(() => {})
    )
  );
}

/** Request full card details from a paired friend (borrower side). */
export async function requestDetails(
  peerId: string,
  cardId: string,
  ctx: Pick<IncomingCtx, 'insertRequest'> = defaultCtx
): Promise<db.RequestRow> {
  const requestId = Crypto.randomUUID();
  await sendBlob(peerId, 'details-request', { requestId, cardId });
  return ctx.insertRequest({
    id: requestId,
    direction: 'out',
    peerId,
    cardId,
    kind: 'details',
    status: 'pending',
  });
}

/** Request an OTP for an approved details window (borrower side). */
export async function requestOtp(
  peerId: string,
  cardId: string,
  amount: string,
  merchant: string,
  ctx: Pick<IncomingCtx, 'insertRequest' | 'listRequests' | 'setRequestStatus'> = defaultCtx
): Promise<db.RequestRow> {
  const requestId = Crypto.randomUUID();
  await sendBlob(peerId, 'otp-request', { requestId, cardId, amount, merchant });

  // Requesting a new OTP automatically revokes any still-open OTP window for
  // the same card - the old OTP is no longer valid once a fresh one is asked
  // for. Tell the owner so their screen flips to Revoked too, but don't fail
  // the request if that notification can't get out.
  for (const old of await ctx.listRequests()) {
    if (
      old.kind === 'otp' &&
      old.cardId === cardId &&
      old.direction === 'out' &&
      old.status === 'approved'
    ) {
      await sendBlob(peerId, 'request-revoke', { requestId: old.id }).catch(() => {});
      await ctx.setRequestStatus(old.id, 'revoked');
      useRevealStore.getState().clearOtp(old.id);
    }
  }

  return ctx.insertRequest({
    id: requestId,
    direction: 'out',
    peerId,
    cardId,
    kind: 'otp',
    amount,
    merchant,
    status: 'pending',
  });
}

/** Owner approves a details request: sends the unlock package + opens the window. */
export async function approveDetails(
  request: db.RequestRow,
  secrets: db.CardSecrets,
  windowMs = DETAILS_WINDOW_MS,
  ctx: Pick<IncomingCtx, 'setRequestStatus'> = defaultCtx
): Promise<void> {
  const expiresAt = Date.now() + windowMs;
  await sendBlob(request.peerId, 'details-approve', {
    requestId: request.id,
    cardId: request.cardId,
    details: secrets,
    expiresAt,
  });
  await ctx.setRequestStatus(request.id, 'approved', expiresAt);
}

/** Owner approves an OTP request: relays the OTP with a short window. */
export async function approveOtp(
  request: db.RequestRow,
  otp: string,
  windowMs = OTP_WINDOW_MS,
  ctx: Pick<IncomingCtx, 'setRequestStatus'> = defaultCtx
): Promise<void> {
  const expiresAt = Date.now() + windowMs;
  await sendBlob(request.peerId, 'otp-approve', {
    requestId: request.id,
    otp,
    expiresAt,
  });
  await ctx.setRequestStatus(request.id, 'approved', expiresAt);
}

/** Owner denies a request. */
export async function denyRequest(
  request: db.RequestRow,
  ctx: Pick<IncomingCtx, 'setRequestStatus'> = defaultCtx
): Promise<void> {
  const kind = request.kind === 'details' ? 'details-deny' : 'otp-deny';
  await sendBlob(request.peerId, kind, { requestId: request.id });
  await ctx.setRequestStatus(request.id, 'denied');
}

/** Borrower withdraws a pending request. */
export async function cancelRequest(
  request: db.RequestRow,
  ctx: Pick<IncomingCtx, 'setRequestStatus'> = defaultCtx
): Promise<void> {
  await sendBlob(request.peerId, 'request-cancel', { requestId: request.id });
  await ctx.setRequestStatus(request.id, 'cancelled');
}

/** Owner revokes an approved window: details/OTP vanish on the borrower's device. */
export async function revokeRequest(
  request: db.RequestRow,
  ctx: Pick<IncomingCtx, 'setRequestStatus'> = defaultCtx
): Promise<void> {
  await sendBlob(request.peerId, 'request-revoke', { requestId: request.id });
  await ctx.setRequestStatus(request.id, 'revoked');
}

/**
 * Decrypt and apply one incoming blob. Returns a short human-readable note
 * (or null if it was unhandled / failed authentication - those are dropped).
 */
export async function handleIncomingBlob(
  blob: { id: string; from: string; kind: string; payload: string },
  ctx: IncomingCtx = defaultCtx
): Promise<string | null> {
  try {
    switch (blob.kind) {
      case 'pair-request': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (
          typeof data.deviceId !== 'string' ||
          typeof data.name !== 'string' ||
          typeof data.pub !== 'string'
        ) {
          return null;
        }
        const existing = await ctx.getPeer(data.deviceId);
        if (existing && existing.status === 'paired') return null;
        await ctx.upsertPeer({
          id: data.deviceId,
          name: data.name,
          publicKey: data.pub,
          direction: 'in',
          status: 'pending',
        });
        return `pair request from ${data.name}`;
      }
      case 'pair-accept': {
        const existing = await ctx.getPeer(blob.from);
        if (existing && existing.direction === 'out') {
          await ctx.setPeerStatus(blob.from, 'paired');
          return `paired with ${existing.name}`;
        }
        return null;
      }
      case 'pair-decline': {
        await ctx.deletePeer(blob.from);
        await ctx.removeSharedCardsByPeer(blob.from);
        // Return a note so pollInbox bumps the inbox event and the Friends /
        // Shared screens refresh live instead of waiting for tab focus.
        return 'peer removed';
      }
      case 'name-update': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.name !== 'string') return null;
        const existing = await ctx.getPeer(blob.from);
        if (!existing) return null;
        const name = data.name.trim().slice(0, 40) || 'Friend';
        if (name === existing.name) return null;
        await ctx.setPeerName(blob.from, name);
        return `name updated: ${name}`;
      }
      case 'card-share': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (
          typeof data.cardId !== 'string' ||
          typeof data.nickname !== 'string' ||
          typeof data.network !== 'string' ||
          typeof data.last4 !== 'string' ||
          typeof data.color !== 'string'
        ) {
          return null;
        }
        await ctx.insertSharedCard({
          peerId: blob.from,
          ownerCardId: data.cardId,
          nickname: data.nickname,
          network: data.network,
          last4: data.last4,
          color: data.color,
          status: 'new',
        });
        return `card share: ${data.nickname}`;
      }
      case 'card-unshare': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.cardId !== 'string') return null;
        await ctx.removeSharedByOwner(blob.from, data.cardId);
        await ctx.cancelRequestsForCard(blob.from, data.cardId);
        useRevealStore.getState().clearDetails(data.cardId);
        const otpState = useRevealStore.getState().otp;
        for (const requestId of Object.keys(otpState)) {
          const r = await ctx.getRequest(requestId);
          if (r && r.cardId === data.cardId) {
            useRevealStore.getState().clearOtp(requestId);
          }
        }
        return 'card unshared';
      }
      case 'details-request': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.requestId !== 'string' || typeof data.cardId !== 'string') {
          return null;
        }
        const peer = await ctx.getPeer(blob.from);
        if (!peer || peer.status !== 'paired') return null;
        await ctx.insertRequest({
          id: data.requestId,
          direction: 'in',
          peerId: blob.from,
          cardId: data.cardId,
          kind: 'details',
          status: 'pending',
        });
        void notify(`${peer.name} wants your card details`, 'Open Requests to approve.');
        return `details request from ${peer.name}`;
      }
      case 'otp-request': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (
          typeof data.requestId !== 'string' ||
          typeof data.cardId !== 'string'
        ) {
          return null;
        }
        const peer = await ctx.getPeer(blob.from);
        if (!peer || peer.status !== 'paired') return null;
        const amount = typeof data.amount === 'string' ? data.amount : null;
        const merchant = typeof data.merchant === 'string' ? data.merchant : null;
        await ctx.insertRequest({
          id: data.requestId,
          direction: 'in',
          peerId: blob.from,
          cardId: data.cardId,
          kind: 'otp',
          amount,
          merchant,
          status: 'pending',
        });
        void notify(
          `${peer.name} requests an OTP`,
          amount ? `₹${amount}${merchant ? ` at ${merchant}` : ''} - open Requests to approve.` : 'Open Requests to approve.'
        );
        return `otp request from ${peer.name}`;
      }
      case 'details-approve': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (
          typeof data.requestId !== 'string' ||
          typeof data.cardId !== 'string' ||
          !data.details ||
          typeof data.details.pan !== 'string'
        ) {
          return null;
        }
        const request = await ctx.getRequest(data.requestId);
        if (!request || request.direction !== 'out' || request.status !== 'pending') {
          return null;
        }
        const expiresAt =
          typeof data.expiresAt === 'number'
            ? data.expiresAt
            : Date.now() + DETAILS_WINDOW_MS;
        await ctx.setRequestStatus(data.requestId, 'approved', expiresAt);
        useRevealStore.getState().setDetails(data.cardId, data.details, expiresAt);
        return 'details approved';
      }
      case 'details-deny': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.requestId !== 'string') return null;
        await ctx.setRequestStatus(data.requestId, 'denied');
        return 'details denied';
      }
      case 'otp-approve': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (
          typeof data.requestId !== 'string' ||
          typeof data.otp !== 'string'
        ) {
          return null;
        }
        const request = await ctx.getRequest(data.requestId);
        if (!request || request.direction !== 'out' || request.status !== 'pending') {
          return null;
        }
        const expiresAt =
          typeof data.expiresAt === 'number'
            ? data.expiresAt
            : Date.now() + OTP_WINDOW_MS;
        await ctx.setRequestStatus(data.requestId, 'approved', expiresAt);
        useRevealStore.getState().setOtp(data.requestId, data.otp, expiresAt);
        return 'otp approved';
      }
      case 'otp-deny': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.requestId !== 'string') return null;
        await ctx.setRequestStatus(data.requestId, 'denied');
        return 'otp denied';
      }
      case 'request-cancel': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.requestId !== 'string') return null;
        await ctx.setRequestStatus(data.requestId, 'cancelled');
        return 'request cancelled';
      }
      case 'request-revoke': {
        const data = JSON.parse(await openFrom(blob.payload));
        if (typeof data.requestId !== 'string') return null;
        const request = await ctx.getRequest(data.requestId);
        if (
          !request ||
          request.peerId !== blob.from ||
          request.status !== 'approved'
        ) {
          return null;
        }
        await ctx.setRequestStatus(data.requestId, 'revoked');
        // Instantly kill only what this request revealed on this device; an
        // OTP revoke must not hide the still-open details window (and vice
        // versa).
        if (request.kind === 'details') {
          useRevealStore.getState().clearDetails(request.cardId);
        } else {
          useRevealStore.getState().clearOtp(request.id);
        }
        return 'request revoked';
      }
      default:
        return null;
    }
  } catch (err) {
    console.error(`[relay] dropped ${blob.kind} blob:`, (err as Error).message);
    return null; // failed auth or malformed: drop silently
  }
}

interface RelayBlob {
  id: string;
  from: string;
  kind: string;
  payload: string;
}

async function applyBlobs(blobs: RelayBlob[], ctx: IncomingCtx): Promise<number> {
  let handled = 0;
  for (const blob of blobs) {
    const note = await handleIncomingBlob(blob, ctx);
    if (note) {
      handled += 1;
      notifyInboxEvent();
    }
  }
  return handled;
}

/** Fetch + apply all pending blobs for this device. Returns count handled. */
export async function pollInbox(
  ctx: IncomingCtx = defaultCtx
): Promise<number> {
  const identity = await getIdentity();
  const path = `/v1/blobs?deviceId=${identity.deviceId}`;
  const signed = signRequest(identity, 'GET', path, '');
  const res = await fetch(`${getRelayUrl()}${path}`, {
    headers: signed.headers,
  }).catch(() => null);
  if (res && res.status === 401) {
    // Device record lost (e.g. relay restart): re-register, try once more.
    await registerDevice();
    const retry = signRequest(identity, 'GET', path, '');
    const res2 = await fetch(`${getRelayUrl()}${path}`, { headers: retry.headers }).catch(() => null);
    if (!res2 || !res2.ok) return 0;
    const data2 = (await res2.json()) as { blobs: RelayBlob[] };
    return applyBlobs(data2.blobs, ctx);
  }
  if (!res || !res.ok) return 0;
  const data = (await res.json()) as { blobs: RelayBlob[] };
  return applyBlobs(data.blobs, ctx);
}

const RETRY_GAP_MS = 3 * 1000;

let polling = false;
let pollAbort: AbortController | null = null;

/**
 * Long-poll loop: holds a relay pickup request open (?wait=1) so incoming
 * blobs are handled within a round trip instead of on a fixed poll interval.
 */
export function startPolling(): void {
  if (polling) return;
  polling = true;
  void pollLoop();
}

async function pollLoop(): Promise<void> {
  while (polling) {
    const controller = new AbortController();
    pollAbort = controller;
    try {
      const identity = await getIdentity();
      const path = `/v1/blobs?deviceId=${identity.deviceId}&wait=1`;
      const signed = signRequest(identity, 'GET', path, '');
      const res = await fetch(`${getRelayUrl()}${path}`, {
        headers: signed.headers,
        signal: controller.signal,
      });
      if (res.status === 401) {
        // Device record lost (e.g. relay restart): re-register before retry.
        await registerDevice();
        throw new Error('Relay poll unauthenticated');
      }
      if (!res.ok) throw new Error(`Relay poll failed: ${res.status}`);
      const data = (await res.json()) as { blobs: RelayBlob[] };
      await applyBlobs(data.blobs, defaultCtx);
    } catch {
      if (polling) await sleep(RETRY_GAP_MS);
    }
  }
  pollAbort = null;
}

export function stopPolling(): void {
  polling = false;
  pollAbort?.abort();
  pollAbort = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
