-- Track when users click subscribe/checkout button (before going to Stripe)
-- Adds: Viewed Pricing → Clicked Checkout → Converted

-- =============================================================================
-- 1. Create checkout_clicks table (simple version)
-- =============================================================================

CREATE TABLE IF NOT EXISTS checkout_clicks (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE checkout_clicks ENABLE ROW LEVEL SECURITY;

-- Users can track their own checkout clicks
CREATE POLICY "Users can track their own checkout clicks"
    ON checkout_clicks
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- 2. Function to track checkout click (simple upsert)
-- =============================================================================

CREATE OR REPLACE FUNCTION track_checkout_click(p_user_id UUID, p_tier VARCHAR DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO checkout_clicks (user_id, clicked_at)
    VALUES (p_user_id, now())
    ON CONFLICT (user_id) DO UPDATE SET
        clicked_at = now();
END;
$$;

-- =============================================================================
-- 3. Update funnel RPC to include clicked_checkout
-- =============================================================================

CREATE OR REPLACE FUNCTION get_free_signups_with_activity(
    date_from TIMESTAMPTZ,
    date_to TIMESTAMPTZ
)
RETURNS TABLE (
    user_id UUID,
    has_activity BOOLEAN,
    viewed_pricing BOOLEAN,
    clicked_checkout BOOLEAN,
    is_converted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH signups AS (
        SELECT
            a.primary_owner_user_id as uid,
            a.id as account_id
        FROM basejump.accounts a
        WHERE a.created_at >= date_from
          AND a.created_at <= date_to
          AND a.personal_account = true
    ),
    activity AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN threads t ON t.account_id = s.account_id
        JOIN agent_runs ar ON ar.thread_id = t.thread_id
    ),
    pricing AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN pricing_views pv ON pv.user_id = s.uid
    ),
    checkout AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN checkout_clicks cc ON cc.user_id = s.uid
    ),
    conversions AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN credit_accounts ca ON ca.account_id = s.account_id
        WHERE ca.tier NOT IN ('free', 'none')
    )
    SELECT
        s.uid as user_id,
        EXISTS (SELECT 1 FROM activity a WHERE a.uid = s.uid) as has_activity,
        EXISTS (SELECT 1 FROM pricing p WHERE p.uid = s.uid) as viewed_pricing,
        EXISTS (SELECT 1 FROM checkout ch WHERE ch.uid = s.uid) as clicked_checkout,
        EXISTS (SELECT 1 FROM conversions c WHERE c.uid = s.uid) as is_converted
    FROM signups s;
END;
$$;
