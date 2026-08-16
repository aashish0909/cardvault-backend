// Node stub for expo-secure-store (used only by scripts/crypto.test.ts).

const store = new Map<string, string>();

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}
