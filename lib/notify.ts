// Local and remote notifications (expo-notifications).
//
// Remote delivery uses an Expo push token registered with the relay. Local
// notifications still cover requests received while the app is foregrounded.

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

let ready = false;
let setupPromise: Promise<void> | null = null;

export function setupNotifications(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    try {
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    } catch {
      // Simulator / denied - non-fatal.
    }
    if (Platform.OS === 'android') {
      try {
        await Notifications.setNotificationChannelAsync('requests', {
          name: 'Card requests',
          importance: Notifications.AndroidImportance.HIGH,
        });
      } catch {
        // Non-fatal.
      }
    }
    ready = true;
  })();
  return setupPromise;
}

export async function getPushToken(): Promise<string | null> {
  await setupNotifications();
  if (!ready) return null;
  try {
    const permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) return null;
    const projectId =
      Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    return token.data;
  } catch (err) {
    console.warn('[notify] remote push registration unavailable:', (err as Error).message);
    return null;
  }
}

export async function notify(title: string, body: string): Promise<void> {
  if (!ready) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,
    });
  } catch {
    // Non-fatal.
  }
}
