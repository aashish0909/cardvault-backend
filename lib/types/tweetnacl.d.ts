// Minimal type declarations for tweetnacl 1.0.3 (no official types in registry).

declare module 'tweetnacl' {
  interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
  interface SignKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
  interface Nacl {
    box: {
      keyPair(): BoxKeyPair;
      nonceLength: number;
      overheadLength: number;
      (
        msg: Uint8Array,
        nonce: Uint8Array,
        publicKey: Uint8Array,
        secretKey: Uint8Array
      ): Uint8Array;
      open(
        box: Uint8Array,
        nonce: Uint8Array,
        publicKey: Uint8Array,
        secretKey: Uint8Array
      ): Uint8Array | null;
    };
    randomBytes(n: number): Uint8Array;
    setPRNG(fn: (x: Uint8Array, n: number) => void): void;
    sign: {
      (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      open(signedMsg: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
      detached: {
        (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
        verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
      };
      keyPair: {
        (): SignKeyPair;
        fromSecretKey(secretKey: Uint8Array): SignKeyPair;
        fromSeed(seed: Uint8Array): SignKeyPair;
      };
      publicKeyLength: number;
      secretKeyLength: number;
      seedLength: number;
      signatureLength: number;
    };
  }
  const nacl: Nacl;
  export default nacl;
}
