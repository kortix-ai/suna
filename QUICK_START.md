# 🚀 Quick Start Guide - Cognito Authentication

Get your Cognito authentication up and running in 5 minutes!

## Prerequisites

- AWS Cognito User Pool configured (same as enso.bot and builder)
- Supabase database with basejump schema
- Node.js and Python installed

## Step 1: Environment Variables (2 minutes)

### Frontend `.env.local`

Create `/frontend/.env.local`:

```bash
# Use the SAME Cognito credentials as enso.bot and builder
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID=your_client_id
NEXT_PUBLIC_COGNITO_REGION=us-east-1
NEXT_PUBLIC_COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com

NEXT_PUBLIC_ENVIRONMENT=local
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_URL=https://super.local.enso.bot:3000
```

### Backend `.env`

Add to `/backend/.env`:

```bash
# Use the SAME Cognito credentials
COGNITO_REGION=us-east-1
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_APP_CLIENT_ID=your_client_id

# Your existing Supabase config
SUPABASE_JWT_SECRET=your_jwt_secret
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## Step 2: AWS Cognito Configuration (1 minute)

In your Cognito User Pool App Client, add these redirect URLs:

**For Local Development:**

- Sign-in: `https://super.local.enso.bot:3000/auth/callback`
- Sign-out: `https://local.enso.bot:5173/app`

## Step 3: Install Dependencies (1 minute)

### Backend

```bash
cd backend
uv sync
```

### Frontend

```bash
cd frontend
npm install
```

> Note: AWS Amplify and PyJWT[crypto] are already in the dependency files!

## Step 4: Start Services (1 minute)

### Terminal 1 - Backend

```bash
cd backend
python api.py
```

**Watch for:** `✅ [API] Cognito auth router registered`

### Terminal 2 - Frontend

```bash
cd frontend
npm run dev
```

## Step 5: Test! (1 minute)

1. **Open browser console** (F12)
2. **Visit** `https://super.local.enso.bot:3000`
3. **Watch the logs:**

```
🚀 [Providers] Rendering app providers
🔐 [Auth Provider] Starting authentication initialization...
📝 [Auth Provider] Step 1: Initializing Amplify...
```

4. **Sign in** - Will redirect to main app
5. **After auth** - Watch for:

```
✅ [Auth Provider] User authenticated with Cognito
🔐 [Internal Auth] Starting internal authentication...
✅ [Internal Auth] Authentication successful
```

6. **Backend logs:**

```
🚀 [Cognito Auth] Starting authentication flow...
✅ [Cognito Verifier] Token verified successfully
🎉 [Cognito Auth] Authentication flow complete!
```

## ✅ Success Indicators

### Frontend (Browser Console)

- ✅ Cognito initialized
- ✅ User authenticated
- ✅ Internal auth successful
- ✅ JWT stored

### Backend (Server Logs)

- ✅ Cognito token verified
- ✅ User found/created
- ✅ JWT generated

## 🐛 Troubleshooting

### "Missing required Cognito configuration"

➡️ Check frontend `.env.local` has all Cognito variables

### "Invalid or expired Cognito token"

➡️ Check backend `.env` has correct Cognito credentials

### "Failed to create user"

➡️ Check Supabase connection and triggers

### Cookies not shared

➡️ Make sure you're accessing via `super.local.enso.bot` (not `localhost`)

## 📖 Full Documentation

- `COGNITO_AUTH_SETUP.md` - Complete setup guide
- `IMPLEMENTATION_SUMMARY.md` - Technical details

## 🎯 What's Next?

1. ✅ **Test new user creation**

   - Sign in with a new email
   - Check logs for "NEW USER CREATED"
   - Verify account and credits in database

2. ✅ **Test existing user**

   - Sign out and sign in again
   - Should use cached JWT

3. ✅ **Test API calls**

   - Make authenticated requests
   - Verify JWT in headers

4. 🚀 **Deploy to staging/production**
   - Update environment variables
   - Configure Cognito redirect URLs
   - Test full flow

## 💡 Pro Tips

1. **Keep browser console open** - All steps are logged
2. **Keep server logs visible** - Backend flow is logged
3. **Use emoji to search logs** - `🔐` for auth, `❌` for errors
4. **Clear localStorage** to test re-auth - `localStorage.clear()`
5. **Check Network tab** - See API calls to `/auth/cognito-verify`

---

**Need help?** Check the full setup guide in `COGNITO_AUTH_SETUP.md`
