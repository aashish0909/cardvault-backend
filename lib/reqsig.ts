// Device-bound request signing (relay auth).
//
// Every authenticated relay call carries an Ed25519 detached signature over a
// canonical request string. The signing seed is derived deterministically
// from this device's X25519 identity secret (no new secrets to store), and
// the derived public key is registered with the relay via POST /v1/devices.
// The relay binds the key to the deviceId at first registration, so a stolen
// deviceId alone cannot pick up mail, hijack push, or forge deposits.
//
// Canonical string (identical on server):
//   cardvault-req-v1\nMETHOD\npath?query\ntimestamp\nnonce\nsha256(body)

import CryptoJS from 'crypto-js';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

import { base64Encode, bytesToHex, hexToBytes, utf8Bytes } from './bytes';
import type { Identity } from './identity';

// tweetnacl needs its PRNG wired before nacl.randomBytes (see lib/identity.ts;
// repeated here so this module stands alone).
nacl.setPRNG((x: Uint8Array) => {
  Crypto.getRandomValues(x);
});

export const SIGN_VERSION = 'cardvault-req-v1';

function sha256Hex(input: string): string {
  return CryptoJS.SHA256(input).toString();
}

/** Ed25519 seed derived from the identity secret (deterministic, 32 bytes). */
function signSeed(identity: Identity): Uint8Array {
  return hexToBytes(sha256Hex(`${SIGN_VERSION}:${identity.secretHex}`));
}

/** Ed25519 public key (hex) this device registers with the relay. */
export function signingPublicKeyHex(identity: Identity): string {
  return bytesToHex(nacl.sign.keyPair.fromSeed(signSeed(identity)).publicKey);
}

export interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

/**
 * Build the exact fetch body + signature headers for one relay request.
 * `pathWithQuery` must be the path (and query) of the URL being fetched,
 * exactly as it goes on the wire.
 */
export function signRequest(
  identity: Identity,
  method: string,
  pathWithQuery: string,
  body: string
): SignedRequest {
  const ts = String(Date.now());
  const nonce = bytesToHex(nacl.randomBytes(16));
  const msg = utf8Bytes(
    [SIGN_VERSION, method.toUpperCase(), pathWithQuery, ts, nonce, sha256Hex(body)].join('\n')
  );
  const sig = nacl.sign.detached(msg, nacl.sign.keyPair.fromSeed(signSeed(identity)).secretKey);
  return {
    body,
    headers: {
      'x-cv-device': identity.deviceId,
      'x-cv-timestamp': ts,
      'x-cv-nonce': nonce,
      'x-cv-signature': base64Encode(sig),
    },
  };
}
