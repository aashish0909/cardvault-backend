// Ephemeral reveal state: card details and OTPs delivered during an approved
// request window. Kept in memory only - deliberately NOT persisted. If the
// app restarts, the window is simply gone and the borrower can request again.
//
// Windows are enforced client-side: values auto-clear when their
// expiresAt passes (timer + UI countdown), and the owner re-approves for any
// subsequent window.

import { create } from 'zustand';

import type { CardSecrets } from './db';

export const DETAILS_WINDOW_MS = 15 * 60 * 1000;
export const OTP_WINDOW_MS = 60 * 1000;

interface RevealState {
  details: Record<string, { secrets: CardSecrets; expiresAt: number }>;
  otp: Record<string, { otp: string; expiresAt: number }>;
  setDetails: (cardId: string, secrets: CardSecrets, expiresAt?: number) => void;
  clearDetails: (cardId: string) => void;
  setOtp: (requestId: string, otp: string, expiresAt?: number) => void;
  clearOtp: (requestId: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useRevealStore = create<RevealState>((set) => ({
  details: {},
  otp: {},

  setDetails: (cardId, secrets, expiresAt) => {
    const at = expiresAt ?? Date.now() + DETAILS_WINDOW_MS;
    set((s) => ({ details: { ...s.details, [cardId]: { secrets, expiresAt: at } } }));
    const existing = timers.get(`d:${cardId}`);
    if (existing) clearTimeout(existing);
    timers.set(
      `d:${cardId}`,
      setTimeout(() => {
        useRevealStore.getState().clearDetails(cardId);
      }, Math.max(0, at - Date.now()))
    );
  },

  clearDetails: (cardId) => {
    const t = timers.get(`d:${cardId}`);
    if (t) clearTimeout(t);
    timers.delete(`d:${cardId}`);
    set((s) => {
      if (!s.details[cardId]) return s;
      const next = { ...s.details };
      delete next[cardId];
      return { details: next };
    });
  },

  setOtp: (requestId, otp, expiresAt) => {
    const at = expiresAt ?? Date.now() + OTP_WINDOW_MS;
    set((s) => ({ otp: { ...s.otp, [requestId]: { otp, expiresAt: at } } }));
    const existing = timers.get(`o:${requestId}`);
    if (existing) clearTimeout(existing);
    timers.set(
      `o:${requestId}`,
      setTimeout(() => {
        useRevealStore.getState().clearOtp(requestId);
      }, Math.max(0, at - Date.now()))
    );
  },

  clearOtp: (requestId) => {
    const t = timers.get(`o:${requestId}`);
    if (t) clearTimeout(t);
    timers.delete(`o:${requestId}`);
    set((s) => {
      if (!s.otp[requestId]) return s;
      const next = { ...s.otp };
      delete next[requestId];
      return { otp: next };
    });
  },
}));
