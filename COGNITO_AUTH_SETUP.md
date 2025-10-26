# Cognito Authentication Setup Guide

This guide will help you configure Cognito authentication for your Super Enso application.

## Overview

The authentication flow works as follows:

1. **User visits super.enso.bot**
2. **Frontend checks Cognito cookies** → Try to authenticate with Cognito
3. **No Cognito auth?** → Redirect to `enso.bot/auth/signin?redirect=https://super.enso.bot/dashboard`
4. **Cognito authenticated?** → Proceed to internal authentication
5. **Internal Authentication** (NO username/password):
   - Send Cognito token to `/api/auth/cognito-verify`
   - Backend verifies Cognito token
   - Check if user exists by Cognito sub
6. **User exists?** → Generate custom JWT → Return to frontend
7. **User doesn't exist?** → Create user → Triggers set up account/credits → Generate custom JWT → Return to frontend
8. **Frontend stores JWT** → Use for all API calls
9. **Navigate to dashboard**

## Environment Variables

### Frontend Configuration

Create a `.env.local` file in `/frontend` with these variables:

```bash
# ============================================================================
# Cognito Configuration (AWS Cognito for Authentication)
# ============================================================================
# These should be the SAME values as used in your main enso.bot app and builder

# Cognito User Pool ID (e.g., us-east-1_XXXXXXXXX)
NEXT_PUBLIC_COGNITO_USER_POOL_ID=your_user_pool_id_here

# Cognito User Pool Client ID
NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID=your_client_id_here

# Cognito Region
NEXT_PUBLIC_COGNITO_REGION=us-east-1

# Cognito Domain (e.g., your-domain.auth.us-east-1.amazoncognito.com)
NEXT_PUBLIC_COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com

# ============================================================================
# Environment Configuration
# ============================================================================
# Options: local, staging, prod
NEXT_PUBLIC_ENVIRONMENT=local

# ============================================================================
# Backend API Configuration
# ============================================================================
# Backend URL for API calls
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000

# ============================================================================
# Application URL (for OAuth callbacks)
# ============================================================================
NEXT_PUBLIC_URL=https://super.local.enso.bot:3000
```

### Backend Configuration

Add these variables to your backend `.env` file:

```bash
# ============================================================================
# Cognito Configuration (AWS Cognito for Authentication)
# ============================================================================
# These should be the SAME values as used in your main enso.bot app and builder

# Cognito Region
COGNITO_REGION=us-east-1

# Cognito User Pool ID (e.g., us-east-1_XXXXXXXXX)
COGNITO_USER_POOL_ID=your_user_pool_id_here

# Cognito App Client ID
COGNITO_APP_CLIENT_ID=your_client_id_here

# ============================================================================
# Supabase Configuration (for JWT generation and database)
# ============================================================================
# Supabase JWT Secret (used to generate internal JWTs)
SUPABASE_JWT_SECRET=your_jwt_secret

# Supabase URL
SUPABASE_URL=your_supabase_url

# Supabase Service Role Key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## AWS Cognito Setup

### 1. Configure Redirect URLs

In your Cognito User Pool App Client settings, add these redirect URLs:

**Local Development:**

- Sign-in redirect: `https://super.local.enso.bot:3000/auth/callback`
- Sign-out redirect: `https://local.enso.bot:5173/app`

**Staging:**

- Sign-in redirect: `https://super.staging.enso.bot/auth/callback`
- Sign-out redirect: `https://staging.enso.bot/app`

**Production:**

- Sign-in redirect: `https://super.enso.bot/auth/callback`
- Sign-out redirect: `https://enso.bot/app`

### 2. Configure Cookie Domain

The application automatically sets cookie domains based on the environment:

- **Local:** `.local.enso.bot`
- **Staging:** `.staging.enso.bot`
- **Production:** `.enso.bot`

This ensures cookies are shared across subdomains (enso.bot, super.enso.bot, builder.enso.bot).

## Installation

### Frontend

```bash
cd frontend
npm install
# AWS Amplify is already in package.json
```

### Backend

```bash
cd backend
uv sync
# PyJWT with crypto support is already in pyproject.toml
```

## Testing the Flow

### 1. Start the Backend

```bash
cd backend
python api.py
```

Watch for these log messages:

```
✅ [API] Cognito auth router registered
```

### 2. Start the Frontend

```bash
cd frontend
npm run dev
```

### 3. Test Authentication Flow

1. Open browser to `https://super.local.enso.bot:3000`
2. Open browser console to see debug logs
3. You should see:

   ```
   🚀 [Providers] Rendering app providers
   🔐 [Auth Provider] Starting authentication initialization...
   📝 [Auth Provider] Step 1: Initializing Amplify...
   ```

4. If not authenticated, you'll see:

   ```
   ⚠️ [Auth Provider] No Cognito authentication found
   ```

5. Click sign in → Should redirect to `enso.bot/auth/signin`

6. After successful Cognito auth, you'll see:

   ```
   ✅ [Auth Provider] Step 2 complete: User authenticated with Cognito
   📝 [Auth Provider] Step 5: No stored JWT, performing internal auth...
   🔐 [Internal Auth] Starting internal authentication...
   ✅ [Internal Auth] Authentication successful
   ```

7. Backend will log:
   ```
   🚀 [Cognito Auth] Starting authentication flow...
   🔐 [Cognito Verifier] Starting token verification...
   ✅ [Cognito Verifier] Token verified successfully
   📝 [User Manager] Processing Cognito user...
   ```

### New User Creation

If it's a new user, you'll see:

```
🎉 [Auth Provider] NEW USER CREATED!
```

Backend will show:

```
📝 [User Manager] User not found, creating new user...
✅ [User Manager] User created successfully!
🎉 [User Manager] NEW USER: {user_id} ({email})
📝 [User Manager] Database triggers will now:
    1. Create personal account
    2. Add user to account_user table
    3. Initialize free tier credits
```

## Debug Logging

The implementation includes comprehensive debug logging at every step:

### Frontend Logs (Browser Console)

- 🔐 Cookie and environment detection
- 🚀 Provider initialization
- 📝 Step-by-step authentication flow
- 🔌 API client requests
- 💾 JWT storage operations

### Backend Logs (Server Console)

- 🔐 Token verification
- 📝 User lookup and creation
- 🎉 New user events
- ⚠️ Warnings and errors

## Files Created/Modified

### Frontend

- ✅ `src/lib/cognito/cookie-util.ts` - Cookie domain management
- ✅ `src/lib/cognito/cognito-auth-service.ts` - Cognito auth service
- ✅ `src/components/CognitoAuthProvider.tsx` - Auth context provider
- ✅ `src/lib/api-client.ts` - Updated to use internal JWT
- ✅ `src/app/providers.tsx` - Updated to use CognitoAuthProvider
- ✅ `src/app/auth/callback/page.tsx` - OAuth callback handler

### Backend

- ✅ `core/utils/cognito_verifier.py` - Cognito token verification
- ✅ `core/auth/cognito_auth.py` - Internal auth API endpoint
- ✅ `core/auth/__init__.py` - Module init
- ✅ `api.py` - Router registration
- ✅ `pyproject.toml` - Updated PyJWT dependency

## API Endpoints

### POST `/api/auth/cognito-verify`

Verifies Cognito token and returns internal JWT.

**Request:**

```json
{
  "cognito_token": "eyJraWQiOiI..."
}
```

**Response:**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "user_id": "uuid",
  "email": "user@example.com",
  "is_new_user": true,
  "message": "New user created and authenticated"
}
```

## Troubleshooting

### No Cognito cookies found

**Symptom:** User is not authenticated even after signing in on main app.

**Solution:**

1. Check cookie domain is set correctly (`.enso.bot` for prod, `.local.enso.bot` for local)
2. Verify you're accessing via the correct domain (e.g., `super.local.enso.bot` not `localhost`)
3. Check browser console for cookie-related errors

### Backend cannot verify token

**Symptom:** `Invalid or expired Cognito token` error

**Solution:**

1. Verify `COGNITO_USER_POOL_ID` and `COGNITO_APP_CLIENT_ID` match your Cognito configuration
2. Check Cognito public keys are accessible at `https://cognito-idp.{region}.amazonaws.com/{pool-id}/.well-known/jwks.json`
3. Ensure PyJWT has crypto support installed: `pip install pyjwt[crypto]`

### User creation fails

**Symptom:** Error when creating new user

**Solution:**

1. Check database connection is working
2. Verify Supabase triggers are in place (`basejump.run_new_user_setup`)
3. Check database logs for trigger errors

### JWT generation fails

**Symptom:** `SUPABASE_JWT_SECRET not configured` error

**Solution:**

1. Set `SUPABASE_JWT_SECRET` in backend environment
2. Verify it matches your Supabase project's JWT secret

## Security Notes

1. **Cognito = Authentication** (who you are)

   - Verified via Cognito public keys
   - Stored in secure, httpOnly cookies

2. **Internal JWT = Authorization** (what you can do)

   - Generated by backend after Cognito verification
   - Used for API calls within Super Enso
   - Does NOT authenticate the user (only Cognito does that)

3. **Cookie Security**
   - Secure: true (HTTPS only)
   - SameSite: lax
   - Domain: environment-specific

## Next Steps

1. Set up environment variables
2. Configure Cognito redirect URLs
3. Test the authentication flow
4. Monitor debug logs to ensure everything works
5. Deploy to staging/production

## Support

For issues or questions:

1. Check browser console logs
2. Check backend server logs
3. Review this setup guide
4. Verify all environment variables are set correctly
