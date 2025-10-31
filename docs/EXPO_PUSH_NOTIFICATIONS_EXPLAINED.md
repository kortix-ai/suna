# Expo Push Notifications Explained

## What Role Does Expo Play?

Expo acts as a **middleman/relay service** for push notifications. Here's the flow:

```
Your Backend → Expo Push API → Apple/Google Push Services → Device
```

### Without Expo (Direct Push):
- You'd need to:
  - Set up Apple Push Notification Service (APNs) certificates
  - Set up Firebase Cloud Messaging (FCM) for Android
  - Handle different push services for iOS vs Android
  - Manage device tokens directly with Apple/Google

### With Expo:
- Expo handles all of this for you
- You send ONE request to Expo's API
- Expo forwards it to the right service (APNs for iOS, FCM for Android)
- Expo provides a unified API for both platforms
- **Free** for basic push notifications (no authentication needed)

## Token Registration Explained

### What is a Push Token?

A push token is a **unique identifier** that Expo generates for each device. It looks like:
```
ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
```

This token tells Expo where to deliver notifications for a specific device.

### The Token Registration Flow

1. **User opens app** → `PushNotificationSetup` component runs
2. **App requests permission** → User grants notification permission
3. **Expo generates token** → `Notifications.getExpoPushTokenAsync()` is called
4. **Token sent to backend** → Mobile app calls `/notifications/register-push-token` API
5. **Backend stores token** → Saved in `user_notification_preferences.push_token` column

### Why Do We Need to Store Tokens?

The backend needs the token to know **where to send notifications**:
- When you send a notification, backend looks up the user's push token
- Backend sends token + notification to Expo API
- Expo uses token to find the device and deliver notification

### How to Check Token Registration

**In your database:**
```sql
SELECT 
  user_id, 
  push_token, 
  push_token_updated_at 
FROM user_notification_preferences 
WHERE push_token IS NOT NULL;
```

This shows:
- Which users have registered push tokens
- What their tokens are
- When they last updated their token

**If query returns no rows:**
- Tokens haven't been registered yet
- User needs to open the app
- App needs to request permissions
- Token registration must succeed

## Do You Need Expo Dashboard Configuration?

### For Basic Push Notifications: **NO** ✅

Expo's push notification API is **public and free**:
- No account required
- No API keys needed
- No dashboard configuration needed
- Just use: `https://exp.host/--/api/v2/push/send`

### For Production Builds: **Maybe** ⚠️

If you're using **EAS Build** to create production apps:

1. **iOS (Apple App Store)**:
   - You need Apple Developer account ($99/year)
   - EAS Build will configure APNs certificates automatically
   - But you need Expo account to use EAS Build

2. **Android (Google Play Store)**:
   - Firebase project (free)
   - EAS Build can set this up automatically
   - But you need Expo account to use EAS Build

3. **For Development (Expo Go)**:
   - No Expo account needed
   - No configuration needed
   - Just works!

### Summary

| Scenario | Expo Account Needed? | Dashboard Config Needed? |
|----------|---------------------|-------------------------|
| Development (Expo Go) | ❌ No | ❌ No |
| EAS Build (Production) | ✅ Yes | ✅ Yes (handled by EAS) |
| Push API (Basic) | ❌ No | ❌ No |

## Complete Push Notification Flow

### 1. Token Registration (One-Time, Per Device)

```
Mobile App (Physical Device)
  ↓ Requests permission
  ↓ Gets token from Expo: ExponentPushToken[abc123...]
  ↓ Sends to your backend API
Your Backend
  ↓ Stores in database
Database: user_notification_preferences.push_token = "ExponentPushToken[abc123...]"
```

### 2. Sending a Notification (Every Time)

```
Your Backend
  ↓ Looks up user's push_token from database
  ↓ Sends to Expo API:
    POST https://exp.host/--/api/v2/push/send
    {
      "to": "ExponentPushToken[abc123...]",
      "title": "Hello",
      "body": "Notification message"
    }
Expo API
  ↓ Forwards to Apple Push Notification Service (iOS)
  ↓ OR Forwards to Firebase Cloud Messaging (Android)
Apple/Google Push Services
  ↓ Delivers to device
Device
  ↓ Shows notification to user
```

## Common Issues & Solutions

### Issue: "No tokens in database"

**Checklist:**
1. User opened app on **physical device** (not simulator)
2. User granted **notification permissions**
3. Token registration API call succeeded
4. Check mobile app console logs for errors

**Debug SQL:**
```sql
-- Check if user has preferences but no token
SELECT * FROM user_notification_preferences 
WHERE user_id = 'YOUR_USER_ID';

-- Check all registered tokens
SELECT user_id, push_token, push_token_updated_at 
FROM user_notification_preferences 
WHERE push_token IS NOT NULL 
ORDER BY push_token_updated_at DESC;
```

### Issue: "Token registration API fails"

**Check backend logs:**
- Look for `POST /notifications/register-push-token`
- Check for authentication errors
- Verify database permissions

### Issue: "Notifications not delivered"

**Check backend logs:**
- Look for Expo API responses
- Check for `DeviceNotRegistered` errors (token expired)
- Verify token format is correct

**Debug:**
```python
# In notification_service.py logs, look for:
# "Push notification sent successfully"
# OR
# "Failed to send push notification: [error]"
```

## Token Lifecycle

1. **Generated**: When app first requests permission
2. **Stored**: In your database when user opens app
3. **Used**: Every time you send a notification
4. **Refreshed**: When user reinstalls app or token expires
5. **Removed**: When user uninstalls app (Expo marks as invalid)

## Next Steps

1. **Test token registration**:
   - Open app on physical device
   - Grant permissions
   - Check database for token

2. **Test sending notification**:
   - Use admin panel to send test notification
   - Check backend logs for Expo API response
   - Verify notification appears on device

3. **Monitor tokens**:
   - Regularly check database for expired tokens
   - Re-register if needed

