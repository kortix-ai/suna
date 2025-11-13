# Supabase Webhook Setup Guide

**TL;DR**: Most people use cloud Supabase + need to expose local backend via ngrok for welcome emails to work in dev.

## How It Works

When a new user signs up, Supabase triggers a database function that calls your backend's `/webhooks/user-created` endpoint to send the welcome email. This eliminates the need for the frontend to act as a middleman.

```
User signs up → Supabase trigger → Backend webhook → Welcome email sent
```

## Check Current Configuration First

Before setting anything, check what's already configured:

**Go to Supabase Dashboard → SQL Editor** and run:

```sql
SELECT * FROM public.webhook_config;
```

**Results:**
- ✅ If you see a row with `backend_url` and `webhook_secret` → Already configured!
- ⚠️ If empty/no rows → Need to configure (see scenarios below)
- ⚠️ If values look wrong → Update them (safe to re-run `INSERT ... ON CONFLICT`)

---

## Setup Scenarios

### Scenario 1: Cloud Supabase + Local Backend 🌐 (Most Common)

**This is the typical local development setup** - using your cloud Supabase project

**Problem**: Cloud Supabase can't reach `http://localhost:8000`

**Solution**: Use a tunnel (like ngrok) to expose your local backend

#### Step 1: Start your local backend
```bash
cd backend
uv run uvicorn api:app --reload --host 0.0.0.0 --port 8000
```

#### Step 2: Expose backend with a tunnel

**Option A: ngrok** (recommended)
```bash
ngrok http 8000
# Note the URL: https://abc123.ngrok.io
```

**Option B: localtunnel**
```bash
npx localtunnel --port 8000
# Note the URL: https://random-name.loca.lt
```

**Option C: Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://localhost:8000
# Note the URL from output
```

#### Step 3: Configure in Supabase

Go to **Supabase Dashboard → SQL Editor** and run:

```sql
-- Insert/update webhook configuration
INSERT INTO public.webhook_config (backend_url, webhook_secret) 
VALUES (
  'https://abc123.ngrok.io',  -- Your ngrok URL from step 2
  'your-secret-from-backend-env'  -- From backend .env
)
ON CONFLICT (id) DO UPDATE 
SET backend_url = EXCLUDED.backend_url,
    webhook_secret = EXCLUDED.webhook_secret,
    updated_at = NOW();
```

**Get your webhook secret**:
```bash
# Check backend .env file
grep SUPABASE_WEBHOOK_SECRET backend/.env
```

#### Step 4: Verify Configuration

```sql
-- Check current config
SELECT * FROM public.webhook_config;
```

Should show your backend URL and webhook secret.

**Note**: If your ngrok URL changes (free plan restarts change it), just re-run the `INSERT ... ON CONFLICT` command with the new URL.

---

### Scenario 2: Cloud Supabase + Cloud Backend 🚀

**Perfect for**: Staging and Production environments

**Setup** (via SQL Editor):

```sql
-- Production
INSERT INTO public.webhook_config (backend_url, webhook_secret) 
VALUES (
  'https://api.yourdomain.com',
  'your-production-secret'
)
ON CONFLICT (id) DO UPDATE 
SET backend_url = EXCLUDED.backend_url,
    webhook_secret = EXCLUDED.webhook_secret,
    updated_at = NOW();

-- Verify
SELECT * FROM public.webhook_config;
```

Ensure backend environment has `SUPABASE_WEBHOOK_SECRET` set to the same value.

---

### Scenario 3: Local Supabase + Docker (Rare) 🐳

**Only if you're running local Supabase** (`npx supabase start`)

This is uncommon but works out of the box with Docker:

**Setup in** `config.toml`:
```toml
[db.settings]
app.backend_url = "http://backend:8000"
app.webhook_secret = "your-generated-secret"
```

**Commands**:
```bash
cd backend/supabase && npx supabase start
docker compose up
```

---

## Verification

### Check if webhook is configured

```sql
-- Run in Supabase SQL Editor
SELECT * FROM public.webhook_config;
```

Should return one row with your backend URL and secret. If empty, webhooks not configured.

### Check webhook logs

In Supabase Dashboard → Database → Logs, you'll see:
- ✅ `NOTICE: Using default backend URL: http://backend:8000` (if not configured)
- ⚠️ `WARNING: Webhook secret not configured` (if missing)
- ⚠️ `WARNING: Using default webhook secret!` (if using default value)

### Test the webhook

Sign up a new user and check:

**Backend logs**:
```
📧 Sending welcome email to new user: test@example.com
```

**Supabase logs** (Database → Logs):
```
LOG: Welcome email webhook triggered for user test@example.com with request_id 12345
```

---

## What if I don't configure webhooks?

The system gracefully degrades if webhooks aren't configured:

**What happens**: 
- ✅ Users can still sign up normally
- ✅ Authentication works fine
- ❌ Welcome emails won't be sent
- ⚠️ Warnings in Supabase logs: `"Webhook secret not configured"`

**For local development without tunnels**:

This is fine! You can test auth flows without welcome emails. If you need to test the email:

1. **Quick tunnel setup** (one-time, 2 minutes):
   ```bash
   ngrok http 8000
   # Copy URL to Supabase Dashboard
   ```

2. **Or use the deprecated endpoint** (temporary workaround):
   - The old `/send-welcome-email` endpoint still exists
   - Frontend was cleaned up, but you could manually call it for testing

**Bottom line**: Webhooks are optional for local dev, required for production.

---

## Troubleshooting

### "Webhook not configured"

Run this in SQL Editor:

```sql
INSERT INTO public.webhook_config (backend_url, webhook_secret) 
VALUES (
  'https://your-backend-url',
  'your-secret-from-backend-env'
)
ON CONFLICT (id) DO UPDATE 
SET backend_url = EXCLUDED.backend_url,
    webhook_secret = EXCLUDED.webhook_secret;
```

### "Using default webhook secret!"

The default value `"your-webhook-secret-here-change-in-production"` is insecure.

**Fix**: 
```bash
# Generate a secure secret
openssl rand -hex 32

# Add to backend .env
SUPABASE_WEBHOOK_SECRET=your-generated-secret

# Update Supabase config (see scenarios above)
```

### Webhook calls but no email sent

Check backend logs for:
```
❌ Error handling user created webhook: ...
```

Common causes:
- `MAILTRAP_API_TOKEN` not configured
- Backend can't reach email service
- Email service rate limit

### "Failed to trigger welcome email webhook"

The `pg_net` extension might not be enabled:
```sql
CREATE EXTENSION IF NOT EXISTS pg_net;
```

---

## Security Notes

1. **Always use HTTPS** for cloud backends
2. **Keep webhook secret secure** - it's in both backend `.env` and Supabase config
3. **Rotate secrets periodically** - update both places when rotating
4. **Use environment variables** in production, not hardcoded values

---

## Related Files

- Migration: `migrations/20251113000000_welcome_email_webhook.sql`
- Backend endpoint: `backend/core/services/email_api.py` → `/webhooks/user-created`
- Config: `config.toml` → `[db.settings]`
- Setup wizard: `setup.py` (auto-generates secrets)

