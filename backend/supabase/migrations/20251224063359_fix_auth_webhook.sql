CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
RETURNS TRIGGER AS $$
DECLARE
  backend_url TEXT;
  webhook_secret TEXT;
  payload JSONB;
  request_id BIGINT;
  config_exists BOOLEAN;
BEGIN
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
  
  SELECT net.http_post(
    url := backend_url || '/v1/webhooks/user-created',
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
    RAISE WARNING 'Failed to trigger welcome email webhook for user %: %', NEW.email, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.trigger_welcome_email() IS 
'Triggers a webhook to the backend when a new user is created. The webhook handles account initialization (free tier + Suna agent) and welcome email. Endpoint: /v1/webhooks/user-created';
