# Push Notification Authentication & User Identification Flow

## How Notifications Are Sent to the Right User

The system ensures notifications reach the correct authenticated user through a **multi-layer authentication and mapping system**. Here's exactly how it works:

## Complete Flow: From Token Registration to Delivery

### Step 1: User Authentication & Token Registration

```
┌─────────────────────────────────────────────────────────────┐
│ Mobile App (User Logged In)                                 │
│ - User is authenticated via JWT token                       │
│ - JWT token is stored in mobile app state                   │
│ - useAuthContext ensures user is authenticated              │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ PushNotificationSetup Component                             │
│ - Only runs if isAuthenticated === true                    │
│ - Requests notification permissions                         │
│ - Gets push token from Expo: ExponentPushToken[abc123...]  │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ API Call: POST /notifications/register-push-token          │
│ Headers: {                                                   │
│   Authorization: "Bearer <JWT_TOKEN>"  ← User's auth token │
│ }                                                           │
│ Body: {                                                      │
│   push_token: "ExponentPushToken[abc123...]"              │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Backend: verify_and_get_user_id_from_jwt()                 │
│ - Extracts JWT token from Authorization header             │
│ - Validates token with Supabase                            │
│ - Extracts user_id from token payload (JWT.sub)            │
│ - Returns: user_id = "123e4567-e89b-12d3-a456-426614174000"│
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Database: user_notification_preferences                     │
│ INSERT/UPDATE:                                              │
│   user_id: "123e4567-e89b-12d3-a456-426614174000"         │
│   push_token: "ExponentPushToken[abc123...]"                │
│   push_token_updated_at: "2024-01-15T10:30:00Z"            │
│                                                             │
│ ✅ Token is now linked to authenticated user_id             │
└─────────────────────────────────────────────────────────────┘
```

### Step 2: Sending a Notification to a User

```
┌─────────────────────────────────────────────────────────────┐
│ Backend: send_notification(user_id="123e4567...")          │
│ - Called by agent completion, admin panel, etc.            │
│ - user_id is provided by caller                             │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Database Lookup                                             │
│ SELECT push_token                                           │
│ FROM user_notification_preferences                          │
│ WHERE user_id = '123e4567-e89b-12d3-a456-426614174000'     │
│                                                             │
│ Returns: push_token = "ExponentPushToken[abc123...]"         │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Backend: Send to Expo API                                   │
│ POST https://exp.host/--/api/v2/push/send                  │
│ Body: {                                                      │
│   "to": "ExponentPushToken[abc123...]",  ← Specific token  │
│   "title": "Agent Completed",                              │
│   "body": "Your agent has finished..."                      │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Expo API                                                    │
│ - Looks up which device owns ExponentPushToken[abc123...]   │
│ - Forwards to Apple Push Notification Service (iOS)        │
│   OR Firebase Cloud Messaging (Android)                     │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Device (Physical Device)                                    │
│ - Receives push notification                                │
│ - Shows notification to user                                │
│ ✅ Correct user receives notification                        │
└─────────────────────────────────────────────────────────────┘
```

## Security Layers

### 1. **Authentication Layer** (JWT Verification)

**When registering token:**
```python
@router.post("/notifications/register-push-token")
async def register_push_token(
    request: RegisterPushTokenRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)  # ← Verifies JWT
):
```

**What happens:**
- Backend extracts JWT from `Authorization: Bearer <token>` header
- Validates token signature with Supabase
- Extracts `user_id` from token payload (`sub` claim)
- **Only authenticated users can register tokens**
- Token cannot be registered for another user (JWT ensures it's the right user)

### 2. **Database Mapping Layer** (User → Token)

**Database Schema:**
```sql
CREATE TABLE user_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    push_token TEXT,  -- ExponentPushToken[abc123...]
    push_token_updated_at TIMESTAMPTZ,
    ...
)
```

**Key Points:**
- `user_id` is the PRIMARY KEY - one token per user
- Token is stored **with** user_id - they're linked forever
- When user logs in on another device, token gets updated (old device stops receiving)

### 3. **Notification Sending Layer** (Token Lookup)

**When sending notification:**
```python
# Get user's push token from database
prefs_result = await client.table('user_notification_preferences')
    .select('*')
    .eq('user_id', user_id)  # ← Lookup by authenticated user_id
    .execute()

push_token = user_prefs.get('push_token')
```

**Security:**
- Backend always looks up token by `user_id` (not by device or other means)
- If user_id doesn't exist → no notification sent
- If token is missing → notification fails gracefully
- Each user_id maps to exactly one push_token

## How Expo Identifies Devices vs How We Identify Users

### Expo's Role (Device Identification)

**Expo knows:**
- Which **device** has which `ExponentPushToken`
- How to deliver notifications to that device
- Nothing about your users or authentication

**Expo doesn't know:**
- User IDs
- Authentication state
- User relationships
- Your business logic

### Your Backend's Role (User Identification)

**Your backend knows:**
- Which **user_id** has which `push_token`
- User authentication state (via JWT)
- User relationships and permissions
- Business logic (who should get which notifications)

**Your backend maps:**
```
user_id (123e4567...) → push_token (ExponentPushToken[abc123...])
```

## Multi-Device Scenario

### What Happens if User Has Multiple Devices?

**Current Implementation:**
- Only **one push_token per user** (stored in database)
- Last device to register token wins
- Older device stops receiving notifications

**Example:**
1. User logs in on iPhone → Token: `ExponentPushToken[iphone123]` stored
2. User logs in on iPad → Token: `ExponentPushToken[ipad456]` stored (replaces iPhone token)
3. Notification sent → Only iPad receives it (iPhone token is old)

**To support multiple devices**, you'd need to:
- Store multiple tokens per user (array or separate table)
- Send notification to all tokens for that user_id

## Security Guarantees

### ✅ What's Protected:

1. **Token Registration**:
   - Requires valid JWT authentication
   - User can only register token for themselves
   - Cannot register token for another user

2. **Notification Sending**:
   - Backend requires `user_id` parameter
   - Only sends to token associated with that `user_id`
   - If user_id is wrong → wrong token → wrong device (but this would be a backend bug, not a security issue)

3. **Database Security**:
   - Row Level Security (RLS) on Supabase tables
   - Users can only access their own notification preferences
   - Admin endpoints require admin authentication

### ⚠️ What Expo Doesn't Handle:

**Expo is device-agnostic:**
- Expo doesn't know which user owns a token
- Expo just delivers to the device that registered the token
- **You** (the backend) are responsible for mapping users to tokens

**This is correct and secure because:**
- Your backend controls which user_id gets which token
- Token registration requires authentication
- Token is stored securely with user_id in your database

## Example: Sending Notification After Agent Completes

```
1. Agent completes thread → Backend calls:
   notification_service.send_notification(
       user_id="123e4567...",  ← From thread.account_id lookup
       title="Agent Completed",
       ...
   )

2. Backend looks up token:
   SELECT push_token 
   FROM user_notification_preferences 
   WHERE user_id = '123e4567...'
   
   Result: ExponentPushToken[abc123...]

3. Backend sends to Expo:
   POST https://exp.host/--/api/v2/push/send
   { "to": "ExponentPushToken[abc123...]", ... }

4. Expo delivers to device that owns that token

5. ✅ Correct user (the one who owns token) receives notification
```

## Verification Queries

**Check token registration:**
```sql
SELECT 
  u.email,  -- Join with auth.users to see email
  unp.user_id,
  unp.push_token,
  unp.push_token_updated_at
FROM user_notification_preferences unp
JOIN auth.users u ON u.id = unp.user_id
WHERE unp.push_token IS NOT NULL;
```

**Check notification delivery:**
```sql
SELECT 
  n.user_id,
  n.title,
  n.push_sent,
  n.push_sent_at,
  n.push_error,
  unp.push_token
FROM notifications n
JOIN user_notification_preferences unp ON unp.user_id = n.user_id
WHERE n.push_sent = true
ORDER BY n.created_at DESC;
```

## Summary

**How it ensures correct user:**

1. ✅ **JWT Authentication**: Token registration requires valid JWT (user authenticated)
2. ✅ **Database Mapping**: Push token stored with user_id (one-to-one mapping)
3. ✅ **User ID Lookup**: When sending, backend looks up token by user_id (ensures correct token)
4. ✅ **Expo Delivery**: Expo delivers to device that owns the token (device-level, not user-level)

**Expo doesn't handle user authentication** - that's your backend's responsibility, and it does it correctly by:
- Verifying JWT on token registration
- Storing tokens with user_id
- Looking up tokens by user_id when sending

