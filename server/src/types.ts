export interface DeviceRecord {
  signPub: string; // Ed25519 public key (hex) that owns this deviceId
  pushToken: string;
  pushSubscription: PushSubscriptionRecord | null;
  platform: 'ios' | 'android' | 'web';
  registeredAt: number;
  lastSeen: number;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface BlobRecord {
  id: string;
  to: string;
  from: string;
  kind: string; // e.g. "pair-request", "card-share", "otp-request", "otp-response"
  payload: string; // opaque E2E-encrypted blob (base64)
  createdAt: number;
  expiresAt: number;
}

export interface PairingCodeRecord {
  code: string;
  payload: { v: number; deviceId: string; name: string; pub: string };
  expiresAt: number;
}

export interface Waiter {
  wake: () => void;
  ip: string;
}
