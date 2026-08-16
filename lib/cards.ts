// Card helpers: network detection, Luhn validation, formatting, masking.

export type CardNetwork =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'rupay'
  | 'discover'
  | 'diners'
  | 'unknown';

export const NETWORK_LABELS: Record<CardNetwork, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  rupay: 'RuPay',
  discover: 'Discover',
  diners: 'Diners',
  unknown: 'Card',
};

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function detectNetwork(pan: string): CardNetwork {
  const d = digitsOnly(pan);
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^3[068]/.test(d)) return 'diners';
  if (/^6(?:011|5)/.test(d)) return 'discover';
  if (/^(60|65|81|82|508)/.test(d)) return 'rupay';
  return 'unknown';
}

export function luhnCheck(pan: string): boolean {
  const d = digitsOnly(pan);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Format PAN for display: Amex uses 4-6-5, everything else 4-4-4-4. */
export function formatPan(pan: string): string {
  const d = digitsOnly(pan);
  const network = detectNetwork(d);
  const groups = network === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= d.length) break;
    parts.push(d.slice(i, i + size));
    i += size;
  }
  return parts.join(' ');
}

export function maskedPan(last4: string): string {
  return `•••• ${last4}`;
}

/** Validate "MM/YY": real month, not in the past. */
export function isValidExpiry(expiry: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!match) return false;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return false;
  const year = 2000 + Number(match[2]);
  const now = new Date();
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);
  return endOfMonth.getTime() >= now.getTime();
}

export function isValidCvv(cvv: string, network: CardNetwork): boolean {
  const d = digitsOnly(cvv);
  return network === 'amex' ? d.length === 4 : d.length === 3;
}

const NETWORK_COLORS: Record<CardNetwork, string> = {
  visa: '#1A3B8F',
  mastercard: '#7A1E1E',
  amex: '#1E5E6E',
  rupay: '#26402F',
  discover: '#8F4A1A',
  diners: '#3E3E5E',
  unknown: '#2A3240',
};

export function colorForNetwork(network: CardNetwork): string {
  return NETWORK_COLORS[network];
}
