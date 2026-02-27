BEGIN;

CREATE OR REPLACE FUNCTION process_monthly_refills()
RETURNS TABLE(
    account_id UUID,
    credits_granted DECIMAL,
    tier VARCHAR,
    next_grant_date TIMESTAMPTZ,
    status TEXT
) 
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_account RECORD;
    v_monthly_credits DECIMAL;
    v_new_balance DECIMAL;
    v_next_grant TIMESTAMPTZ;
    v_period_start BIGINT;
    v_period_end BIGINT;
    v_accounts_processed INT := 0;
    v_already_processed BOOLEAN;
    v_existing_processor TEXT;
    v_months_since_start INT;
    v_year_end_date TIMESTAMPTZ;
BEGIN
    RAISE NOTICE '[YEARLY REFILL] Starting monthly credit refill scan at %', NOW();
    
    FOR v_account IN 
        SELECT 
            ca.account_id,
            ca.tier,
            ca.next_credit_grant,
            ca.billing_cycle_anchor,
            ca.stripe_subscription_id,
            ca.stripe_subscription_status,
            ca.expiring_credits,
            ca.non_expiring_credits,
            ca.balance
        FROM credit_accounts ca
        WHERE ca.plan_type = 'yearly'
        AND ca.next_credit_grant IS NOT NULL
        AND ca.next_credit_grant <= NOW()
        AND ca.tier IS NOT NULL 
        AND ca.tier != 'none'
        AND ca.tier != 'free'
        AND ca.billing_cycle_anchor IS NOT NULL
        AND ca.stripe_subscription_id IS NOT NULL
        AND ca.stripe_subscription_status = 'active'
        ORDER BY ca.next_credit_grant ASC
    LOOP
        BEGIN
            v_year_end_date := v_account.billing_cycle_anchor + INTERVAL '1 year';
            v_months_since_start := EXTRACT(MONTH FROM AGE(v_account.next_credit_grant, v_account.billing_cycle_anchor))::INT + 
                                   (EXTRACT(YEAR FROM AGE(v_account.next_credit_grant, v_account.billing_cycle_anchor))::INT * 12);
            
            IF v_months_since_start >= 12 THEN
                RAISE NOTICE '[YEARLY REFILL] Account % has reached 12-month limit (started: %, current: %, months: %), marking for Stripe renewal', 
                    v_account.account_id, v_account.billing_cycle_anchor, v_account.next_credit_grant, v_months_since_start;
                
                UPDATE credit_accounts ca
                SET 
                    next_credit_grant = v_year_end_date,
                    updated_at = NOW()
                WHERE ca.account_id = v_account.account_id;
                
                RETURN QUERY SELECT 
                    v_account.account_id,
                    0::DECIMAL,
                    v_account.tier,
                    v_year_end_date,
                    'yearly_period_complete_awaiting_stripe_renewal'::TEXT;
                
                RAISE NOTICE '[YEARLY REFILL] Set next_credit_grant to year end %. Stripe will handle renewal via webhook.', v_year_end_date;
                CONTINUE;
            END IF;
            
            CASE v_account.tier
                WHEN 'tier_2_20' THEN v_monthly_credits := 20.00;
                WHEN 'tier_6_50' THEN v_monthly_credits := 50.00;
                WHEN 'tier_25_200' THEN v_monthly_credits := 200.00;
                ELSE 
                    RAISE NOTICE '[YEARLY REFILL] Unknown tier % for account %, skipping', v_account.tier, v_account.account_id;
                    CONTINUE;
            END CASE;
            
            v_period_start := EXTRACT(EPOCH FROM v_account.next_credit_grant)::BIGINT;
            v_next_grant := v_account.next_credit_grant + INTERVAL '1 month';
            v_period_end := EXTRACT(EPOCH FROM v_next_grant)::BIGINT;
            
            SELECT EXISTS(
                SELECT 1 FROM public.renewal_processing 
                WHERE renewal_processing.account_id = v_account.account_id 
                AND period_start = v_period_start
            ), (
                SELECT processed_by FROM public.renewal_processing
                WHERE renewal_processing.account_id = v_account.account_id
                AND period_start = v_period_start
                LIMIT 1
            ) INTO v_already_processed, v_existing_processor;
            
            IF v_already_processed THEN
                RAISE NOTICE '[YEARLY REFILL] Period % already processed by % for account %, skipping', 
                    v_period_start, v_existing_processor, v_account.account_id;
                
                RETURN QUERY SELECT 
                    v_account.account_id,
                    0::DECIMAL,
                    v_account.tier,
                    NULL::TIMESTAMPTZ,
                    ('already_processed_by_' || v_existing_processor)::TEXT;
                CONTINUE;
            END IF;
            
            INSERT INTO public.renewal_processing (
                account_id, 
                period_start, 
                period_end, 
                subscription_id,
                processed_by, 
                credits_granted
            ) VALUES (
                v_account.account_id,
                v_period_start,
                v_period_end,
                COALESCE(v_account.stripe_subscription_id, 'unknown'),
                'cron',
                v_monthly_credits
            );
            
            RAISE NOTICE '[YEARLY REFILL] Processing account % - tier: %, credits: %, period: % to % (month %/12)', 
                v_account.account_id, v_account.tier, v_monthly_credits, v_account.next_credit_grant, v_next_grant, v_months_since_start + 1;
            
            UPDATE credit_accounts ca
            SET 
                expiring_credits = v_monthly_credits,
                non_expiring_credits = COALESCE(ca.non_expiring_credits, 0),
                balance = v_monthly_credits + COALESCE(ca.non_expiring_credits, 0),
                next_credit_grant = v_next_grant,
                last_grant_date = NOW(),
                updated_at = NOW()
            WHERE ca.account_id = v_account.account_id
            RETURNING ca.balance INTO v_new_balance;
            
            INSERT INTO credit_ledger (
                account_id,
                amount,
                balance_after,
                type,
                description,
                is_expiring,
                metadata,
                processing_source
            ) VALUES (
                v_account.account_id,
                v_monthly_credits,
                v_new_balance,
                'tier_grant',
                'Yearly plan monthly credit refill: ' || v_account.tier || ' (month ' || (v_months_since_start + 1)::TEXT || '/12)',
                true,
                jsonb_build_object(
                    'tier', v_account.tier,
                    'plan_type', 'yearly',
                    'period_start', v_period_start,
                    'period_end', v_period_end,
                    'processed_by', 'cron',
                    'refill_date', NOW(),
                    'month_number', v_months_since_start + 1,
                    'billing_cycle_anchor', v_account.billing_cycle_anchor
                ),
                'cron'
            );
            
            v_accounts_processed := v_accounts_processed + 1;
            
            RETURN QUERY SELECT 
                v_account.account_id,
                v_monthly_credits,
                v_account.tier,
                v_next_grant,
                ('success_month_' || (v_months_since_start + 1)::TEXT || '_of_12')::TEXT;
            
            RAISE NOTICE '[YEARLY REFILL] Successfully granted % credits to account %, next refill: %', 
                v_monthly_credits, v_account.account_id, v_next_grant;
                
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING '[YEARLY REFILL] Error processing account %: %', v_account.account_id, SQLERRM;
            
            RETURN QUERY SELECT 
                v_account.account_id,
                0::DECIMAL,
                v_account.tier,
                NULL::TIMESTAMPTZ,
                ('error: ' || SQLERRM)::TEXT;
        END;
    END LOOP;
    
    RAISE NOTICE '[YEARLY REFILL] Completed. Processed % accounts', v_accounts_processed;
    RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION process_monthly_refills() TO service_role;

COMMENT ON FUNCTION process_monthly_refills IS 'Processes monthly credit refills for yearly plan subscribers with 12-month limit check and idempotency tracking';

COMMIT;
