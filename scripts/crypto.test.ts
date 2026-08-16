// Round-trip + tamper tests for lib/crypto.ts, runnable in Node:
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/crypto.test.ts
//
// expo-crypto and expo-secure-store are stubbed (see scripts/stubs/) so the
// real production code path is exercised end to end.

import assert from 'node:assert';
import { decryptJSON, encryptJSON } from '../lib/crypto';

async function main() {
  const secret = {
    holderName: 'AASHISH ANAND',
    pan: '4242424242424242',
    expiry: '12/29',
    cvv: '123',
    note: 'unicode check: ₹ € 你好',
  };

  // 1. Round trip.
  const payload = await encryptJSON(secret);
  const decrypted = await decryptJSON<typeof secret>(payload);
  assert.deepStrictEqual(decrypted, secret, 'round trip mismatch');
  console.log('ok - round trip (incl. unicode)');

  // 2. Random IV: same plaintext encrypts to different payloads.
  const again = await encryptJSON(secret);
  assert.notStrictEqual(payload, again, 'IV reuse detected');
  assert.deepStrictEqual(await decryptJSON(again), secret);
  console.log('ok - unique IV per encryption');

  // 3. Tamper with ciphertext -> integrity check must fail.
  const raw = Buffer.from(payload, 'base64');
  raw[20] ^= 0xff; // inside ciphertext region
  await assert.rejects(
    () => decryptJSON(raw.toString('base64')),
    /integrity check/,
    'tampered ciphertext was not rejected'
  );
  console.log('ok - ciphertext tampering detected');

  // 4. Tamper with the tag -> must fail.
  const raw2 = Buffer.from(payload, 'base64');
  raw2[raw2.length - 1] ^= 0x01;
  await assert.rejects(() => decryptJSON(raw2.toString('base64')));
  console.log('ok - tag tampering detected');

  // 5. Truncated / malformed payload -> must fail.
  await assert.rejects(() => decryptJSON('aGVsbG8='));
  console.log('ok - malformed payload rejected');

  console.log('\nAll crypto tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
