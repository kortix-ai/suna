# Expo Push Notifications Setup Guide

This guide explains how to configure Expo push notifications for the mobile app.

## Prerequisites

1. **Expo Account & Project**: You need an Expo account and project set up
2. **Physical Device**: Push notifications don't work reliably on simulators
3. **Dependencies**: `expo-notifications` and `expo-device` packages (already installed)

## Configuration Steps

### 1. Get Your Expo Project ID

The project ID is already configured in `apps/mobile/app.json`:
```json
{
  "extra": {
    "eas": {
      "projectId": "9fca3cff-a291-41c9-88b9-feb8053b990f"
    }
  }
}
```

### 2. Set Environment Variable (Mobile App)

Add to your mobile app `.env` file (or Expo environment):

```bash
# Mobile app .env (apps/mobile/.env or .env.local)
EXPO_PUBLIC_PROJECT_ID=9fca3cff-a291-41c9-88b9-feb8053b990f
```

**Note**: This is optional but recommended. The app will use the project ID from `app.json` if not set.

### 3. Backend Configuration

The backend uses Expo's public API which doesn't require authentication for basic push notifications.

**Optional Environment Variable** (backend `.env`):
```bash
# Default is used if not set
EXPO_API_URL=https://exp.host/--/api/v2/push/send
```

**Default is already correct**, so you don't need to set this unless using a custom Expo push service.

### 4. Verify Package Installation

Make sure packages are installed in `apps/mobile`:

```bash
cd apps/mobile
npm list expo-notifications expo-device
```

Should show:
- `expo-notifications@^0.32.12`
- `expo-device@^0.x.x`

### 5. Build Configuration

#### For Development (Expo Go)

Push notifications work in Expo Go, but you need:
- Physical device
- Permissions granted
- Token registered with backend

#### For Production (EAS Build)

If using EAS Build, make sure `app.json` includes:

```json
{
  "expo": {
    "plugins": [
      "expo-notifications"
    ]
  }
}
```

**Note**: The plugin is not explicitly in the config, but it should work. If notifications fail in production builds, you may need to add it.

## Troubleshooting

### Issue: "Push notifications not working"

**Checklist:**

1. **Physical Device**: 
   - ❌ Won't work on iOS Simulator or Android Emulator (mostly)
   - ✅ Must use physical device or Expo Go on physical device

2. **Permissions**:
   - Check if permissions are granted in app
   - iOS: Settings → [Your App] → Notifications
   - Android: Settings → Apps → [Your App] → Notifications

3. **Push Token Registration**:
   - Check backend logs for token registration
   - Verify token is saved in `user_notification_preferences.push_token`
   - Query: `SELECT push_token FROM user_notification_preferences WHERE user_id = 'YOUR_USER_ID'`

4. **Backend Sending**:
   - Check backend logs when sending notification
   - Look for Expo API response errors
   - Verify `notification_service.py` is calling Expo API correctly

### Issue: "Token registration fails"

**Possible causes:**
- Network issue between mobile app and backend
- Backend API endpoint not accessible
- Authentication token invalid
- Database permissions issue

**Debug:**
```typescript
// In mobile app, check console logs
// Look for: "Push notification registration failed: [error]"
```

### Issue: "Expo API returns error"

**Common Expo API errors:**

1. **DeviceNotRegistered**: 
   - Token expired or invalid
   - User uninstalled app
   - Solution: Re-register token on next app open

2. **InvalidCredentials**: 
   - Token format invalid
   - Solution: Check token format (should start with "ExponentPushToken")

3. **MessageTooBig**: 
   - Notification payload too large
   - Solution: Reduce title/message length

**Debug backend logs:**
```python
# Check notification_service.py logs
# Look for: "Failed to send push notification" or Expo API errors
```

### Issue: "Notifications not appearing on device"

**Possible causes:**
1. **App in foreground**: 
   - Notifications may be handled differently when app is open
   - Check notification listeners are set up

2. **OS notification settings**:
   - Check device notification settings
   - Ensure app has permission

3. **Token not registered**:
   - User needs to open app at least once
   - Token registration happens on app open (if authenticated)

## Testing

### 1. Test Token Registration

```bash
# Check if token is registered
# In backend, query database:
SELECT user_id, push_token, push_token_updated_at 
FROM user_notification_preferences 
WHERE push_token IS NOT NULL;
```

### 2. Test Sending Notification

Use the admin panel to send a test notification:
1. Go to `/admin/notifications`
2. Fill out notification form
3. Select "Send Push Notification"
4. Send to your user ID
5. Check device for notification

### 3. Check Backend Logs

```bash
# Look for:
# - "Push notification sent successfully"
# - Expo API errors
# - Token validation errors
```

## Production Considerations

### Apple Push Notification Service (APNs)

For production iOS builds, you'll need:
1. Apple Developer account
2. APNs certificates configured in EAS Build
3. `expo-notifications` plugin configured

### Firebase Cloud Messaging (FCM)

For production Android builds:
1. Firebase project
2. `google-services.json` configured
3. FCM server key (if using FCM directly, but Expo handles this)

**Note**: Expo abstracts this, so you mostly just need EAS Build configured correctly.

## Code Flow

1. **User opens app** → `PushNotificationSetup` component mounts
2. **Hook registers** → `usePushNotifications` runs
3. **Permissions requested** → User grants notification permission
4. **Token generated** → `Notifications.getExpoPushTokenAsync()` called
5. **Token sent to backend** → `registerPushToken()` API call
6. **Backend saves token** → Stored in `user_notification_preferences.push_token`
7. **Notification sent** → Backend calls Expo API with token
8. **Expo delivers** → Push notification appears on device

## Common Environment Variables

### Mobile App (.env)
```bash
EXPO_PUBLIC_PROJECT_ID=9fca3cff-a291-41c9-88b9-feb8053b990f  # Optional, from app.json
EXPO_PUBLIC_SUPABASE_URL=your_supabase_url
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

### Backend (.env)
```bash
# Optional - defaults work for most cases
EXPO_API_URL=https://exp.host/--/api/v2/push/send
```

## Next Steps

1. **Verify setup**:
   - [ ] Environment variables set
   - [ ] Physical device ready
   - [ ] Permissions granted
   - [ ] Token registered in database

2. **Test flow**:
   - [ ] Send test notification from admin panel
   - [ ] Verify notification appears on device
   - [ ] Check backend logs for errors

3. **Debug if needed**:
   - [ ] Check mobile app console logs
   - [ ] Check backend logs
   - [ ] Verify database entries
   - [ ] Test Expo API directly if needed

