import { log } from '@/lib/logger';
/**
 * Push Notification Service
 * 
 * Service for sending push notifications via Expo Push Notification Service
 */

export interface PushNotificationData {
  [key: string]: string | number | boolean | null | undefined;
}

export interface PushNotificationOptions {
  /** Sound to play when notification is received */
  sound?: 'default' | null;
  /** Priority of the notification */
  priority?: 'default' | 'normal' | 'high';
  /** Badge count to display on app icon */
  badge?: number;
  /** Additional data to attach to the notification */
  data?: PushNotificationData;
}

export interface PushNotificationResponse {
  status: 'ok' | 'error';
  id?: string;
  errors?: Array<{
    code: string;
    message: string;
  }>;
}

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification via Expo Push Notification Service
 * 
 * @param expoPushToken - The Expo push token of the recipient device
 * @param title - Notification title
 * @param body - Notification body text
 * @param options - Optional notification configuration
 * @returns Promise resolving to the push notification response
 * 
 * @example
 * ```ts
 * await sendPushNotification(
 *   'ExponentPushToken[xxxxx]',
 *   'New Message',
 *   'You have a new message',
 *   { data: { threadId: '123' } }
 * );
 * ```
 */
export async function sendPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
  options: PushNotificationOptions = {}
): Promise<PushNotificationResponse> {
  if (!expoPushToken?.trim()) {
    throw new Error('Expo push token is required');
  }

  if (!title?.trim()) {
    throw new Error('Notification title is required');
  }

  if (!body?.trim()) {
    throw new Error('Notification body is required');
  }

  const message = {
    to: expoPushToken.trim(),
    sound: options.sound ?? 'default',
    title: title.trim(),
    body: body.trim(),
    priority: options.priority ?? 'default',
    badge: options.badge,
    data: options.data || {},
  };

  try {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to send push notification: ${response.status} ${response.statusText}. ${errorText}`
      );
    }

    const result = await response.json();
    
    // Handle Expo API response format (can be array or single object)
    const responses = Array.isArray(result) ? result : [result];
    const firstResponse = responses[0];

    if (firstResponse.status === 'error') {
      const errorMessage = firstResponse.message || 'Unknown error';
      throw new Error(`Push notification error: ${errorMessage}`);
    }

    log.log('✅ Push notification sent successfully:', firstResponse);
    return firstResponse;
  } catch (error) {
    log.error('❌ Error sending push notification:', error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error(`Unexpected error sending push notification: ${String(error)}`);
  }
}

/**
 * Send push notifications to multiple recipients
 * 
 * @param expoPushTokens - Array of Expo push tokens
 * @param title - Notification title
 * @param body - Notification body text
 * @param options - Optional notification configuration
 * @returns Promise resolving to array of push notification responses
 */
export async function sendPushNotificationsToMultiple(
  expoPushTokens: string[],
  title: string,
  body: string,
  options: PushNotificationOptions = {}
): Promise<PushNotificationResponse[]> {
  if (!expoPushTokens || expoPushTokens.length === 0) {
    throw new Error('At least one Expo push token is required');
  }

  const messages = expoPushTokens
    .filter((token) => token?.trim())
    .map((token) => ({
      to: token.trim(),
      sound: options.sound ?? 'default',
      title: title.trim(),
      body: body.trim(),
      priority: options.priority ?? 'default',
      badge: options.badge,
      data: options.data || {},
    }));

  if (messages.length === 0) {
    throw new Error('No valid Expo push tokens provided');
  }

  try {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to send push notifications: ${response.status} ${response.statusText}. ${errorText}`
      );
    }

    const results = await response.json();
    const responses = Array.isArray(results) ? results : [results];
    
    const errors = responses.filter((r) => r.status === 'error');
    if (errors.length > 0) {
      log.warn(`⚠️ ${errors.length} push notification(s) failed:`, errors);
    }

    const successes = responses.filter((r) => r.status === 'ok');
    log.log(`✅ ${successes.length} push notification(s) sent successfully`);

    return responses;
  } catch (error) {
    log.error('❌ Error sending push notifications:', error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error(`Unexpected error sending push notifications: ${String(error)}`);
  }
}
