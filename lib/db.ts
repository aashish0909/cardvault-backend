// Local vault storage (expo-sqlite).
//
// Cards: `payload` is the AES-GCM-style encrypted JSON of CardSecrets (see
// lib/crypto.ts). Only non-sensitive metadata (nickname, network, last4) is
// stored in the clear so lists render without touching the encryption key.
//
// Peers / shares: pairing + card-sharing state. Shared card records carry only
// masked metadata by design - full card details are revealed only during an
// approved OTP request window (Phase 3), so nothing decryptable is ever at
// rest on the recipient's device.

import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

export interface CardSecrets {
  holderName: string;
  pan: string;
  expiry: string; // "MM/YY"
  cvv: string;
}

export interface CardRow {
  id: string;
  nickname: string;
  network: string;
  last4: string;
  color: string;
  payload: string; // encrypted CardSecrets
  createdAt: number;
}

export type PeerDirection = 'in' | 'out';
export type PeerStatus = 'pending' | 'paired';

export interface PeerRow {
  id: string; // device id
  name: string;
  publicKey: string; // hex X25519 public key
  direction: PeerDirection;
  status: PeerStatus;
  createdAt: number;
}

export interface ShareRow {
  id: string;
  cardId: string;
  peerId: string;
  createdAt: number;
}

export type SharedCardStatus = 'new' | 'accepted' | 'removed';

export interface SharedCardRow {
  id: string;
  peerId: string;
  ownerCardId: string;
  nickname: string;
  network: string;
  last4: string;
  color: string;
  /** Local-only display label chosen by the recipient; falls back to nickname when null. */
  label: string | null;
  status: SharedCardStatus;
  createdAt: number;
}

export type RequestDirection = 'in' | 'out';
export type RequestKind = 'details' | 'otp';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'revoked';

// A request is correlated on both devices by the OWNER's card id (cardId) and
// a shared request id. Direction is relative to the local device: 'in' means
// someone is asking me; 'out' means I asked someone.
export interface RequestRow {
  id: string;
  direction: RequestDirection;
  peerId: string;
  cardId: string;
  kind: RequestKind;
  amount: string | null;
  merchant: string | null;
  status: RequestStatus;
  windowExpiresAt: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface CardDbRow {
  id: string;
  nickname: string;
  network: string;
  last4: string;
  color: string;
  payload: string;
  created_at: number;
}

interface PeerDbRow {
  id: string;
  name: string;
  public_key: string;
  direction: string;
  status: string;
  created_at: number;
}

interface ShareDbRow {
  id: string;
  card_id: string;
  peer_id: string;
  created_at: number;
}

interface SharedCardDbRow {
  id: string;
  peer_id: string;
  owner_card_id: string;
  nickname: string;
  network: string;
  last4: string;
  color: string;
  label: string | null;
  status: string;
  created_at: number;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('cardvault.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY NOT NULL,
          nickname TEXT NOT NULL,
          network TEXT NOT NULL,
          last4 TEXT NOT NULL,
          color TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          public_key TEXT NOT NULL,
          direction TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shares (
          id TEXT PRIMARY KEY NOT NULL,
          card_id TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shared_cards (
          id TEXT PRIMARY KEY NOT NULL,
          peer_id TEXT NOT NULL,
          owner_card_id TEXT NOT NULL,
          nickname TEXT NOT NULL,
          network TEXT NOT NULL,
          last4 TEXT NOT NULL,
          color TEXT NOT NULL,
          label TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY NOT NULL,
          direction TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          card_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          amount TEXT,
          merchant TEXT,
          status TEXT NOT NULL,
          window_expires_at INTEGER,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
      `);
      // Idempotent migration for installs that predate the `label` column on
      // shared_cards (no versioned migration system - CREATE TABLE IF NOT
      // EXISTS never touches existing tables).
      const sharedCols = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(shared_cards)'
      );
      if (!sharedCols.some((c) => c.name === 'label')) {
        await db.execAsync('ALTER TABLE shared_cards ADD COLUMN label TEXT');
      }
      return db;
    });
  }
  return dbPromise;
}

// --- cards ----------------------------------------------------------------

export async function listCards(): Promise<CardRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CardDbRow>(
    'SELECT * FROM cards ORDER BY created_at DESC'
  );
  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    network: r.network,
    last4: r.last4,
    color: r.color,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

export async function getCard(id: string): Promise<CardRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CardDbRow>(
    'SELECT * FROM cards WHERE id = ?',
    [id]
  );
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    network: row.network,
    last4: row.last4,
    color: row.color,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export interface NewCard {
  nickname: string;
  network: string;
  last4: string;
  color: string;
  payload: string;
}

export async function insertCard(card: NewCard): Promise<CardRow> {
  const db = await getDb();
  const id = Crypto.randomUUID();
  const createdAt = Date.now();
  await db.runAsync(
    'INSERT INTO cards (id, nickname, network, last4, color, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, card.nickname, card.network, card.last4, card.color, card.payload, createdAt]
  );
  return { id, createdAt, ...card };
}

export async function deleteCard(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM cards WHERE id = ?', [id]);
}

// --- peers ----------------------------------------------------------------

export async function listPeers(): Promise<PeerRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PeerDbRow>(
    'SELECT * FROM peers ORDER BY created_at DESC'
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    publicKey: r.public_key,
    direction: r.direction as PeerDirection,
    status: r.status as PeerStatus,
    createdAt: r.created_at,
  }));
}

export async function getPeer(deviceId: string): Promise<PeerRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<PeerDbRow>(
    'SELECT * FROM peers WHERE id = ?',
    [deviceId]
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    direction: row.direction as PeerDirection,
    status: row.status as PeerStatus,
    createdAt: row.created_at,
  };
}

export async function upsertPeer(
  peer: Omit<PeerRow, 'createdAt'>
): Promise<void> {
  const db = await getDb();
  const createdAt = Date.now();
  await db.runAsync(
    `INSERT INTO peers (id, name, public_key, direction, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       public_key = excluded.public_key,
       direction = excluded.direction,
       status = excluded.status`,
    [peer.id, peer.name, peer.publicKey, peer.direction, peer.status, createdAt]
  );
}

export async function setPeerStatus(
  deviceId: string,
  status: PeerStatus
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE peers SET status = ? WHERE id = ?', [
    status,
    deviceId,
  ]);
}

/** Update the display name stored for a peer (e.g. from a name-update blob). */
export async function setPeerName(
  deviceId: string,
  name: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE peers SET name = ? WHERE id = ?', [name, deviceId]);
}

export async function deletePeer(deviceId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM peers WHERE id = ?', [deviceId]);
}

// --- shares (owner side) --------------------------------------------------

export async function listShares(cardId?: string): Promise<ShareRow[]> {
  const db = await getDb();
  const rows = cardId
    ? await db.getAllAsync<ShareDbRow>(
        'SELECT * FROM shares WHERE card_id = ? ORDER BY created_at DESC',
        [cardId]
      )
    : await db.getAllAsync<ShareDbRow>('SELECT * FROM shares ORDER BY created_at DESC');
  return rows.map((r) => ({
    id: r.id,
    cardId: r.card_id,
    peerId: r.peer_id,
    createdAt: r.created_at,
  }));
}

export async function addShare(cardId: string, peerId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO shares (id, card_id, peer_id, created_at) VALUES (?, ?, ?, ?)',
    [Crypto.randomUUID(), cardId, peerId, Date.now()]
  );
}

export async function removeShare(
  cardId: string,
  peerId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM shares WHERE card_id = ? AND peer_id = ?',
    [cardId, peerId]
  );
}

// --- shared cards (recipient side) ----------------------------------------

export async function listSharedCards(): Promise<SharedCardRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<SharedCardDbRow>(
    "SELECT * FROM shared_cards WHERE status != 'removed' ORDER BY created_at DESC"
  );
  const mapped = rows.map((r) => ({
    id: r.id,
    peerId: r.peer_id,
    ownerCardId: r.owner_card_id,
    nickname: r.nickname,
    network: r.network,
    last4: r.last4,
    color: r.color,
    label: r.label,
    status: r.status as SharedCardStatus,
    createdAt: r.created_at,
  }));
  const seen = new Set<string>();
  const unique: SharedCardRow[] = [];
  const extraIds: string[] = [];
  for (const r of mapped) {
    const key = `${r.peerId}:${r.ownerCardId}`;
    if (seen.has(key)) extraIds.push(r.id);
    else {
      seen.add(key);
      unique.push(r);
    }
  }
  if (extraIds.length > 0) {
    void Promise.all(
      extraIds.map((id) =>
        db.runAsync("UPDATE shared_cards SET status = 'removed' WHERE id = ?", [id]).catch(() => {})
      )
    );
  }
  return unique;
}

export async function getSharedCard(id: string): Promise<SharedCardRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<SharedCardDbRow>(
    'SELECT * FROM shared_cards WHERE id = ?',
    [id]
  );
  if (!row) return null;
  return {
    id: row.id,
    peerId: row.peer_id,
    ownerCardId: row.owner_card_id,
    nickname: row.nickname,
    network: row.network,
    last4: row.last4,
    color: row.color,
    label: row.label,
    status: row.status as SharedCardStatus,
    createdAt: row.created_at,
  };
}

export async function insertSharedCard(
  shared: Omit<SharedCardRow, 'id' | 'createdAt' | 'label'> & {
    label?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  const existing = await db.getFirstAsync<{
    id: string;
    label: string | null;
    created_at: number;
  }>(
    `SELECT id, label, created_at FROM shared_cards
     WHERE peer_id = ? AND owner_card_id = ?
     ORDER BY CASE WHEN status = 'removed' THEN 1 ELSE 0 END, created_at DESC
     LIMIT 1`,
    [shared.peerId, shared.ownerCardId]
  );
  const label = shared.label !== undefined ? shared.label : (existing?.label ?? null);
  const id = existing?.id ?? Crypto.randomUUID();
  const createdAt = existing?.created_at ?? Date.now();
  await db.runAsync(
    `INSERT INTO shared_cards (id, peer_id, owner_card_id, nickname, network, last4, color, label, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       nickname = excluded.nickname,
       network = excluded.network,
       last4 = excluded.last4,
       color = excluded.color,
       label = excluded.label,
       status = excluded.status`,
    [
      id,
      shared.peerId,
      shared.ownerCardId,
      shared.nickname,
      shared.network,
      shared.last4,
      shared.color,
      label,
      shared.status,
      createdAt,
    ]
  );
  await db.runAsync(
    "UPDATE shared_cards SET status = 'removed' WHERE peer_id = ? AND owner_card_id = ? AND id != ?",
    [shared.peerId, shared.ownerCardId, id]
  );
}

/** Local-only display label for a shared card; null falls back to the
 *  owner's nickname. */
export async function setSharedCardLabel(
  id: string,
  label: string | null
): Promise<void> {
  const db = await getDb();
  const value = label == null ? null : label.trim().slice(0, 40) || null;
  await db.runAsync('UPDATE shared_cards SET label = ? WHERE id = ?', [
    value,
    id,
  ]);
}

export async function setSharedCardStatus(
  id: string,
  status: SharedCardStatus
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE shared_cards SET status = ? WHERE id = ?', [
    status,
    id,
  ]);
}

export async function removeSharedByOwner(
  peerId: string,
  ownerCardId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE shared_cards SET status = 'removed' WHERE peer_id = ? AND owner_card_id = ? AND status != 'removed'",
    [peerId, ownerCardId]
  );
}

/** Cancel any pending requests for a card, e.g. when the owner stops sharing. */
export async function cancelRequestsForCard(
  peerId: string,
  ownerCardId: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE requests SET status = 'cancelled', resolved_at = ? WHERE peer_id = ? AND card_id = ? AND status = 'pending'",
    [Date.now(), peerId, ownerCardId]
  );
}

export async function removeSharedCardsByPeer(peerId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE shared_cards SET status = 'removed' WHERE peer_id = ? AND status != 'removed'",
    [peerId]
  );
}

export async function removeSharesByPeer(peerId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM shares WHERE peer_id = ?', [peerId]);
}

// --- requests --------------------------------------------------------------

interface RequestDbRow {
  id: string;
  direction: string;
  peer_id: string;
  card_id: string;
  kind: string;
  amount: string | null;
  merchant: string | null;
  status: string;
  window_expires_at: number | null;
  created_at: number;
  resolved_at: number | null;
}

function toRequestRow(r: RequestDbRow): RequestRow {
  return {
    id: r.id,
    direction: r.direction as RequestDirection,
    peerId: r.peer_id,
    cardId: r.card_id,
    kind: r.kind as RequestKind,
    amount: r.amount,
    merchant: r.merchant,
    status: r.status as RequestStatus,
    windowExpiresAt: r.window_expires_at,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export async function insertRequest(
  request: Omit<
    RequestRow,
    'createdAt' | 'resolvedAt' | 'windowExpiresAt' | 'amount' | 'merchant'
  > & { amount?: string | null; merchant?: string | null; createdAt?: number }
): Promise<RequestRow> {
  const db = await getDb();
  const createdAt = request.createdAt ?? Date.now();
  await db.runAsync(
    `INSERT INTO requests (id, direction, peer_id, card_id, kind, amount, merchant, status, window_expires_at, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    [
      request.id,
      request.direction,
      request.peerId,
      request.cardId,
      request.kind,
      request.amount ?? null,
      request.merchant ?? null,
      request.status,
      createdAt,
    ]
  );
  return {
    ...request,
    amount: request.amount ?? null,
    merchant: request.merchant ?? null,
    createdAt,
    windowExpiresAt: null,
    resolvedAt: null,
  };
}

export async function listRequests(): Promise<RequestRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RequestDbRow>(
    'SELECT * FROM requests ORDER BY created_at DESC'
  );
  return rows.map(toRequestRow);
}

export async function getRequest(id: string): Promise<RequestRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<RequestDbRow>(
    'SELECT * FROM requests WHERE id = ?',
    [id]
  );
  return row ? toRequestRow(row) : null;
}

export async function setRequestStatus(
  id: string,
  status: RequestStatus,
  windowExpiresAt: number | null = null
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE requests SET status = ?, window_expires_at = ?, resolved_at = ? WHERE id = ?`,
    [status, windowExpiresAt, status === 'pending' ? null : Date.now(), id]
  );
}

/** Delete resolved (non-pending) request rows - the visible request history. */
export async function clearRequestHistory(): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM requests WHERE status != 'pending'");
}
