-- Migration: Setup webhook trigger for welcome emails
-- This migration creates a trigger that calls the backend when a new user is created
-- Instead of having the frontend trigger the email, Supabase will call the backend directly

-- ============================================================================
-- SETUP REQUIRED: Configure webhook after migration
-- ============================================================================
-- 
-- After running this migration, configure in Supabase Dashboard → SQL Editor:
--
-- 1. Get your webhook secret from backend:
--    grep SUPABASE_WEBHOOK_SECRET backend/.env
--
-- 2. For local dev, expose backend with ngrok:
--    ngrok http 8000  (note the https URL)
--
-- 3. Insert/update config:
--    INSERT INTO public.webhook_config (backend_url, webhook_secret) 
--    VALUES (
--      'https://your-ngrok-url.ngrok.io',  -- or production URL
--      'your-secret-from-step-1'
--    )
--    ON CONFLICT (id) DO UPDATE 
--    SET backend_url = EXCLUDED.backend_url,
--        webhook_secret = EXCLUDED.webhook_secret;
--
-- 4. Verify:
--    SELECT * FROM public.webhook_config;
--
-- Full setup guide: backend/supabase/WEBHOOK_SETUP.md
-- ============================================================================

-- Enable pg_net extension for making HTTP requests from Postgres
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================================
-- Create config table to store webhook settings
-- ============================================================================
-- This approach works on all Supabase plans (no superuser permissions needed)

CREATE TABLE IF NOT EXISTS public.webhook_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  backend_url TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Only service_role can modify this table
ALTER TABLE public.webhook_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage webhook config"
  ON public.webhook_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Block public access
CREATE POLICY "No public access"
  ON public.webhook_config
  FOR ALL
  TO anon, authenticated
  USING (false);

-- Allow the trigger function to read
GRANT SELECT ON public.webhook_config TO postgres;

-- Add helpful comment
COMMENT ON TABLE public.webhook_config IS 
'Webhook configuration for backend integration. 
Configure via: INSERT INTO public.webhook_config (backend_url, webhook_secret) VALUES (''https://your-url'', ''your-secret'') ON CONFLICT (id) DO UPDATE SET backend_url = EXCLUDED.backend_url, webhook_secret = EXCLUDED.webhook_secret, updated_at = NOW();';

-- ============================================================================
-- HOW TO CONFIGURE (run in SQL Editor after migration):
-- ============================================================================
--
-- INSERT INTO public.webhook_config (backend_url, webhook_secret) 
-- VALUES (
--   'https://your-backend-url',  -- Your ngrok/backend URL
--   'your-secret-from-backend-env'  -- From SUPABASE_WEBHOOK_SECRET
-- )
-- ON CONFLICT (id) DO UPDATE 
-- SET backend_url = EXCLUDED.backend_url,
--     webhook_secret = EXCLUDED.webhook_secret,
--     updated_at = NOW();
--
-- To check current config:
-- SELECT * FROM public.webhook_config;
-- ============================================================================

-- Create function to trigger welcome email webhook
CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
RETURNS TRIGGER AS $$
DECLARE
  backend_url TEXT;
  webhook_secret TEXT;
  payload JSONB;
  request_id BIGINT;
  config_exists BOOLEAN;
BEGIN
  -- Get config from table
  SELECT EXISTS (SELECT 1 FROM public.webhook_config WHERE id = 1) INTO config_exists;
  
  IF NOT config_exists THEN
    RAISE WARNING 'Webhook not configured. Run: INSERT INTO public.webhook_config (backend_url, webhook_secret) VALUES (''https://your-url'', ''your-secret'');';
    RETURN NEW;
  END IF;
  
  SELECT wc.backend_url, wc.webhook_secret 
  INTO backend_url, webhook_secret
  FROM public.webhook_config wc
  WHERE wc.id = 1;
  
  IF backend_url IS NULL OR backend_url = '' THEN
    RAISE WARNING 'backend_url not configured in webhook_config table';
    RETURN NEW;
  END IF;
  
  IF webhook_secret IS NULL OR webhook_secret = '' THEN
    RAISE WARNING 'webhook_secret not configured in webhook_config table';
    RETURN NEW;
  END IF;
  
  -- Build webhook payload
  payload := jsonb_build_object(
    'type', 'INSERT',
    'table', 'users',
    'schema', 'auth',
    'record', jsonb_build_object(
      'id', NEW.id,
      'email', NEW.email,
      'raw_user_meta_data', NEW.raw_user_meta_data,
      'created_at', NEW.created_at
    )
  );
  
  -- Make async HTTP request to backend webhook
  -- Using pg_net for non-blocking HTTP requests
  SELECT net.http_post(
    url := backend_url || '/api/webhooks/user-created',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Webhook-Secret', webhook_secret
    ),
    body := payload
  ) INTO request_id;
  
  RAISE LOG 'Welcome email webhook triggered for user % with request_id %', NEW.email, request_id;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the user creation
    RAISE WARNING 'Failed to trigger welcome email webhook for user %: %', NEW.email, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger on auth.users table
DROP TRIGGER IF EXISTS on_auth_user_created_webhook ON auth.users;
CREATE TRIGGER on_auth_user_created_webhook
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_welcome_email();

-- Grant necessary permissions
GRANT USAGE ON SCHEMA net TO postgres, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO postgres, service_role;

COMMENT ON FUNCTION public.trigger_welcome_email() IS 
'Triggers a webhook to the backend when a new user is created to send welcome email. This eliminates the need for the frontend to call the backend.';

