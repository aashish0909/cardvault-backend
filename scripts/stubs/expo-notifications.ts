// Node stub for expo-notifications (used only by scripts/*.test.ts).

export function setNotificationHandler(): void {}

export async function requestPermissionsAsync(): Promise<{ granted: boolean; status: string }> {
  return { granted: true, status: 'granted' };
}

export async function getPermissionsAsync(): Promise<{ granted: boolean; status: string }> {
  return { granted: true, status: 'granted' };
}

export async function getExpoPushTokenAsync(): Promise<{ data: string }> {
  return { data: '' };
}

export async function setNotificationChannelAsync(): Promise<void> {}

export async function scheduleNotificationAsync(): Promise<string> {
  return 'stub-notification';
}

export const AndroidImportance = { HIGH: 4, DEFAULT: 3 };
