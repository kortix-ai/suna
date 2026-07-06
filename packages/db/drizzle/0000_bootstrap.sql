-- Allow function bodies to reference objects created later (pg_dump preamble).
SET check_function_bodies = false;
--> statement-breakpoint
-- 0000_bootstrap — non-kortix baseline for fresh installs (curated from prod
-- 2026-06-05; basejump retired 2026-07-06): public credit RPC functions, auth
-- email reader, welcome webhook, storage buckets, plus a minimal
-- basejump.account_user STUB — the kortix baseline migration still creates RLS
-- policies that reference it (rewritten right after by
-- 20260706120000000_retire_basejump). The stub holds no data, has no triggers,
-- and goes away entirely with the final drop-schema migration. kortix.* is
-- generated in 0001. Assumes a fresh Supabase stack (auth, storage, roles).

create extension if not exists pgcrypto;
--> statement-breakpoint
create extension if not exists pg_net;
--> statement-breakpoint
create extension if not exists pg_trgm with schema public;
--> statement-breakpoint
-- public helpers (auth email reader)
CREATE OR REPLACE FUNCTION public.get_user_email(user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_email TEXT;
BEGIN
    SELECT email INTO user_email
    FROM auth.users
    WHERE id = user_id;
    
    IF user_email IS NULL THEN
        SELECT 
            COALESCE(
                raw_user_meta_data->>'email',
                raw_user_meta_data->>'user_email',
                email
            ) INTO user_email
        FROM auth.users
        WHERE id = user_id;
    END IF;
    
    RETURN user_email;
END;
$function$
;
--> statement-breakpoint
SET default_tablespace = '';
--> statement-breakpoint
SET default_table_access_method = "heap";
--> statement-breakpoint
RESET ALL;
--> statement-breakpoint
-- Minimal basejump stub — see header. Matches scripts/test-prereqs.sql.
CREATE SCHEMA IF NOT EXISTS "basejump";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE n.nspname='basejump' AND t.typname='account_role') THEN
    CREATE TYPE "basejump"."account_role" AS ENUM ('owner','member');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."account_user" (
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "account_role" "basejump"."account_role" NOT NULL,
  PRIMARY KEY ("user_id","account_id")
);
--> statement-breakpoint
-- public: atomic credit RPC functions (operate on kortix.credit_accounts)
CREATE OR REPLACE FUNCTION public.atomic_add_credits(p_account_id uuid, p_amount numeric, p_is_expiring boolean DEFAULT true, p_description text DEFAULT 'Credit added'::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_type text DEFAULT NULL::text, p_stripe_event_id text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_current_balance NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tier TEXT;
    v_ledger_id UUID;
BEGIN
    -- Idempotency: check stripe_event_id
    IF p_stripe_event_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE stripe_event_id = p_stripe_event_id
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (duplicate prevented)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    -- Idempotency: check idempotency_key
    IF p_idempotency_key IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE idempotency_key = p_idempotency_key
            AND created_at > NOW() - INTERVAL '1 hour'
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (idempotent)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    SELECT expiring_credits, non_expiring_credits, balance, tier
    INTO v_current_expiring, v_current_non_expiring, v_current_balance, v_tier
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        v_current_expiring := 0;
        v_current_non_expiring := 0;
        v_current_balance := 0;
        v_tier := 'none';

        INSERT INTO kortix.credit_accounts (
            account_id, expiring_credits, non_expiring_credits, balance, tier
        ) VALUES (
            p_account_id, 0, 0, 0, v_tier
        );
    END IF;

    IF p_is_expiring THEN
        v_new_expiring := v_current_expiring + p_amount;
        v_new_non_expiring := v_current_non_expiring;
    ELSE
        v_new_expiring := v_current_expiring;
        v_new_non_expiring := v_current_non_expiring + p_amount;
    END IF;

    v_new_total := v_new_expiring + v_new_non_expiring;

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, idempotency_key, processing_source
    ) VALUES (
        p_account_id, p_amount, v_new_total,
        COALESCE(p_type, CASE WHEN p_is_expiring THEN 'tier_grant' ELSE 'purchase' END),
        p_description, p_is_expiring, p_expires_at,
        p_stripe_event_id, p_idempotency_key, 'atomic_function'
    ) RETURNING id INTO v_ledger_id;

    RETURN jsonb_build_object(
        'success', true,
        'expiring_credits', v_new_expiring,
        'non_expiring_credits', v_new_non_expiring,
        'total_balance', v_new_total,
        'ledger_id', v_ledger_id
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_daily_credit_refresh(p_account_id uuid, p_credit_amount numeric, p_tier text, p_processed_by text, p_refresh_interval_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_last_refresh TIMESTAMPTZ;
    v_now TIMESTAMPTZ := NOW();
    v_refresh_date DATE := v_now::DATE;
    v_already_refreshed BOOLEAN;
    v_interval INTERVAL;
    v_should_refresh BOOLEAN := FALSE;
    v_old_daily NUMERIC(10, 2);
    v_old_total NUMERIC(10, 2);
    v_new_daily NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tracking_id UUID;
    v_credits_added NUMERIC(10, 2);
BEGIN
    v_interval := (p_refresh_interval_hours || ' hours')::INTERVAL;
    
    -- Lock and get current state
    SELECT last_daily_refresh, daily_credits_balance, balance
    INTO v_last_refresh, v_old_daily, v_old_total
    FROM credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'account_not_found',
            'duplicate_prevented', false
        );
    END IF;
    
    -- Check if already refreshed today (using tracking table for idempotency)
    SELECT EXISTS(
        SELECT 1 FROM daily_refresh_tracking
        WHERE account_id = p_account_id
        AND refresh_date = v_refresh_date
    ) INTO v_already_refreshed;
    
    IF v_already_refreshed THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_refreshed_today',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Check if interval has elapsed
    IF v_last_refresh IS NULL THEN
        v_should_refresh := TRUE;
    ELSIF v_now - v_last_refresh > v_interval THEN
        v_should_refresh := TRUE;
    END IF;
    
    IF NOT v_should_refresh THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'interval_not_elapsed',
            'duplicate_prevented', false,
            'last_refresh', v_last_refresh,
            'next_refresh', v_last_refresh + v_interval
        );
    END IF;
    
    -- Insert tracking record (idempotency check)
    INSERT INTO daily_refresh_tracking (
        account_id,
        refresh_date,
        credits_granted,
        tier,
        processed_by
    ) VALUES (
        p_account_id,
        v_refresh_date,
        p_credit_amount,
        p_tier,
        p_processed_by
    )
    ON CONFLICT (account_id, refresh_date) DO NOTHING
    RETURNING id INTO v_tracking_id;
    
    IF v_tracking_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'concurrent_refresh_prevented',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Reset daily credits to the configured amount (don't touch monthly!)
    v_new_daily := p_credit_amount;
    v_credits_added := p_credit_amount - COALESCE(v_old_daily, 0);
    v_new_total := v_old_total + v_credits_added;
    
    UPDATE credit_accounts
    SET
        daily_credits_balance = v_new_daily,
        balance = v_new_total,
        last_daily_refresh = v_now,
        updated_at = v_now
    WHERE account_id = p_account_id;
    
    -- Log to ledger
    INSERT INTO credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        metadata
    ) VALUES (
        p_account_id,
        v_credits_added,
        v_new_total,
        'daily_refresh',
        format('Daily credits refresh: %s → %s', COALESCE(v_old_daily, 0), v_new_daily),
        TRUE,
        v_now + v_interval,
        jsonb_build_object(
            'tier', p_tier,
            'refresh_date', v_refresh_date,
            'old_daily', v_old_daily,
            'new_daily', v_new_daily,
            'refresh_interval_hours', p_refresh_interval_hours,
            'tracking_id', v_tracking_id
        )
    );
    
    RAISE NOTICE '[DAILY REFRESH] Account % daily credits: % → % (total: %)', 
        p_account_id, v_old_daily, v_new_daily, v_new_total;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', v_credits_added,
        'new_daily_balance', v_new_daily,
        'new_total_balance', v_new_total,
        'refresh_date', v_refresh_date,
        'old_daily', v_old_daily,
        'duplicate_prevented', false,
        'tracking_id', v_tracking_id
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_grant_renewal_credits(p_account_id uuid, p_period_start bigint, p_period_end bigint, p_credits numeric, p_processed_by text, p_invoice_id text DEFAULT NULL::text, p_stripe_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_already_processed BOOLEAN;
    v_existing_processor TEXT;
    v_current_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.renewal_processing
        WHERE account_id = p_account_id AND period_start = p_period_start
    ), (
        SELECT processed_by FROM public.renewal_processing
        WHERE account_id = p_account_id AND period_start = p_period_start
        LIMIT 1
    ) INTO v_already_processed, v_existing_processor;

    IF v_already_processed THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_processed',
            'processed_by', v_existing_processor,
            'duplicate_prevented', true
        );
    END IF;

    INSERT INTO public.renewal_processing (
        account_id, period_start, period_end, subscription_id,
        processed_by, credits_granted, stripe_event_id
    )
    SELECT p_account_id, p_period_start, p_period_end, stripe_subscription_id,
           p_processed_by, p_credits, p_stripe_event_id
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id;

    SELECT non_expiring_credits INTO v_current_non_expiring
    FROM kortix.credit_accounts WHERE account_id = p_account_id;

    v_current_non_expiring := COALESCE(v_current_non_expiring, 0);
    v_new_total := p_credits + v_current_non_expiring;
    v_expires_at := TO_TIMESTAMP(p_period_end);

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = p_credits,
        balance = v_new_total,
        last_grant_date = TO_TIMESTAMP(p_period_start),
        next_credit_grant = TO_TIMESTAMP(p_period_end),
        last_processed_invoice_id = COALESCE(p_invoice_id, last_processed_invoice_id),
        last_renewal_period_start = p_period_start,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, processing_source
    ) VALUES (
        p_account_id, p_credits, v_new_total, 'tier_grant',
        'Monthly renewal: ' || p_processed_by,
        true, v_expires_at, p_stripe_event_id, p_processed_by
    );

    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', p_credits,
        'new_balance', v_new_total,
        'expiring_credits', p_credits,
        'non_expiring_credits', v_current_non_expiring,
        'processed_by', p_processed_by
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'reason', 'error',
        'error', SQLERRM
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_reset_expiring_credits(p_account_id uuid, p_new_credits numeric, p_description text DEFAULT 'Monthly credit renewal'::text, p_stripe_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_current_balance NUMERIC(10, 2);
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_actual_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT balance, expiring_credits, non_expiring_credits
    INTO v_current_balance, v_current_expiring, v_current_non_expiring
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Account not found');
    END IF;

    IF v_current_balance <= v_current_non_expiring THEN
        v_actual_non_expiring := v_current_balance;
    ELSE
        v_actual_non_expiring := v_current_non_expiring;
    END IF;

    v_new_total := p_new_credits + v_actual_non_expiring;
    v_expires_at := DATE_TRUNC('month', NOW() + INTERVAL '1 month') + INTERVAL '1 month';

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = p_new_credits,
        non_expiring_credits = v_actual_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, metadata, processing_source
    ) VALUES (
        p_account_id, p_new_credits, v_new_total, 'tier_grant', p_description,
        true, v_expires_at, p_stripe_event_id,
        jsonb_build_object(
            'renewal', true,
            'non_expiring_preserved', v_actual_non_expiring,
            'previous_balance', v_current_balance
        ),
        'atomic_function'
    );

    RETURN jsonb_build_object(
        'success', true,
        'new_expiring', p_new_credits,
        'non_expiring', v_actual_non_expiring,
        'total_balance', v_new_total
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_use_credits(p_account_id uuid, p_amount numeric, p_description text DEFAULT 'Credit usage'::text, p_thread_id text DEFAULT NULL::text, p_message_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
    DECLARE
      v_daily NUMERIC(10,2); v_exp NUMERIC(10,2); v_nonexp NUMERIC(10,2); v_total NUMERIC(10,2);
      v_fd NUMERIC(10,2):=0; v_fe NUMERIC(10,2):=0; v_fn NUMERIC(10,2):=0;
      v_rem NUMERIC(10,2); v_nd NUMERIC(10,2); v_ne NUMERIC(10,2); v_nn NUMERIC(10,2); v_nt NUMERIC(10,2);
      v_tid UUID;
    BEGIN
      SELECT COALESCE(daily_credits_balance,0),COALESCE(expiring_credits,0),
             COALESCE(non_expiring_credits,0),COALESCE(balance,0)
      INTO v_daily,v_exp,v_nonexp,v_total
      FROM kortix.credit_accounts WHERE account_id=p_account_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','No credit account found','required',p_amount,'available',0); END IF;
      v_rem:=p_amount;
      IF v_rem>0 AND v_daily>0 THEN IF v_daily>=v_rem THEN v_fd:=v_rem;v_rem:=0; ELSE v_fd:=v_daily;v_rem:=v_rem-v_daily; END IF; END IF;
      IF v_rem>0 AND v_exp>0 THEN IF v_exp>=v_rem THEN v_fe:=v_rem;v_rem:=0; ELSE v_fe:=v_exp;v_rem:=v_rem-v_exp; END IF; END IF;
      IF v_rem>0 THEN v_fn:=v_rem;v_rem:=0; END IF;
      v_nd:=v_daily-v_fd; v_ne:=v_exp-v_fe; v_nn:=v_nonexp-v_fn; v_nt:=v_nd+v_ne+v_nn;
      UPDATE kortix.credit_accounts SET daily_credits_balance=v_nd,expiring_credits=v_ne,
        non_expiring_credits=v_nn,balance=v_nt,updated_at=NOW() WHERE account_id=p_account_id;
      INSERT INTO kortix.credit_ledger(account_id,amount,balance_after,type,description,metadata)
      VALUES(p_account_id,-p_amount,v_nt,'usage',p_description,
        jsonb_build_object('from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,'thread_id',p_thread_id,'message_id',p_message_id))
      RETURNING id INTO v_tid;
      RETURN jsonb_build_object('success',true,'amount_deducted',p_amount,'new_total',v_nt,
        'new_daily',v_nd,'new_expiring',v_ne,'new_non_expiring',v_nn,
        'from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,
        'from_expiring',v_fe,'from_non_expiring',v_fn,'transaction_id',v_tid);
    END; $function$
;
--> statement-breakpoint
-- public: welcome-email webhook function (before its trigger)
CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;
--> statement-breakpoint
-- auth.users signup triggers
drop trigger if exists on_auth_user_created on auth.users;
--> statement-breakpoint
drop trigger if exists on_auth_user_created_webhook on auth.users;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created_webhook AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION trigger_welcome_email();
--> statement-breakpoint
-- storage buckets
insert into storage.buckets (id,name,public) values ('agent-profile-images','agent-profile-images','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('avatars','avatars','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('browser-screenshots','browser-screenshots','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('file-uploads','file-uploads','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('image-uploads','image-uploads','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('legacy-migrations','legacy-migrations','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('recordings','recordings','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('staged-files','staged-files','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('ui_grounding','ui_grounding','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('ui_grounding_trajs','ui_grounding_trajs','f') on conflict (id) do nothing;
