// Node stubs for expo-sqlite + react-native (used only by scripts/*.test.ts).
// Tests override every db call through the relay context, so these never run.

export async function openDatabaseAsync(): Promise<never> {
  throw new Error('expo-sqlite is stubbed in Node tests');
}

export const Platform = {
  OS: 'ios',
};
