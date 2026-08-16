// Countdown to an absolute expiry timestamp (ms epoch). Ticks every second.

import { useEffect, useState } from 'react';

export function useCountdown(expiresAt: number | null | undefined): {
  remainingMs: number;
  expired: boolean;
} {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (expiresAt == null) {
    return { remainingMs: 0, expired: false };
  }
  const remainingMs = Math.max(0, expiresAt - now);
  return { remainingMs, expired: remainingMs === 0 };
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
