// End-to-end encryption between paired devices.
//
// Uses tweetnacl's crypto_box: X25519 key agreement + XSalsa20-Poly1305
// authenticated encryption. Each message is a sealed envelope:
//
//   base64( JSON { senderPub, nonce, box } )
//
// `senderPub` rides outside the box (public keys are not secret); it is
// required to open the box and the box's auth tag proves the sender holds the
// matching secret key. Decryption without the sender's public key is
// impossible, so the relay can never read payloads.

import nacl from 'tweetnacl';

import { getIdentity } from './identity';
import {
  base64Decode,
  base64Encode,
  bytesToUtf8,
  hexToBytes,
  utf8Bytes,
} from './bytes';

interface SealedEnvelope {
  senderPub: string; // hex
  nonce: string; // base64
  box: string; // base64
}

/** Encrypt plaintext to a recipient's public key (async: reads our identity). */
export async function sealTo(
  plaintext: string,
  recipientPubHex: string
): Promise<string> {
  const identity = await getIdentity();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(
    utf8Bytes(plaintext),
    nonce,
    hexToBytes(recipientPubHex),
    hexToBytes(identity.secretHex)
  );
  const envelope: SealedEnvelope = {
    senderPub: identity.pubHex,
    nonce: base64Encode(nonce),
    box: base64Encode(box),
  };
  return base64Encode(utf8Bytes(JSON.stringify(envelope)));
}

/**
 * Open a sealed envelope with our own secret key. Throws if the payload is
 * not from the claimed sender or has been tampered with.
 */
export async function openFrom(sealedBase64: string): Promise<string> {
  const identity = await getIdentity();
  const envelope = JSON.parse(
    bytesToUtf8(base64Decode(sealedBase64))
  ) as SealedEnvelope;
  if (
    typeof envelope.senderPub !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.box !== 'string'
  ) {
    throw new Error('Malformed sealed envelope');
  }
  const opened = nacl.box.open(
    base64Decode(envelope.box),
    base64Decode(envelope.nonce),
    hexToBytes(envelope.senderPub),
    hexToBytes(identity.secretHex)
  );
  if (!opened) {
    throw new Error('Message failed authentication (wrong sender or tampered)');
  }
  return bytesToUtf8(opened);
}
