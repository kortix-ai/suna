-- User Funnel Analytics: Track pricing views and query funnel data
-- Tracks: Signup → Tried Task → Viewed Pricing → Converted

-- =============================================================================
-- 1. Create pricing_views table
-- =============================================================================

CREATE TABLE IF NOT EXISTS pricing_views (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    view_count INT NOT NULL DEFAULT 1,
    last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE pricing_views ENABLE ROW LEVEL SECURITY;

-- Users can insert/update their own pricing views
CREATE POLICY "Users can track their own pricing views"
    ON pricing_views
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to upsert pricing view (insert or increment count)
CREATE OR REPLACE FUNCTION track_pricing_view(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO pricing_views (user_id, first_viewed_at, view_count, last_viewed_at)
    VALUES (p_user_id, now(), 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
        view_count = pricing_views.view_count + 1,
        last_viewed_at = now();
END;
$$;

-- =============================================================================
-- 2. Create RPC to get funnel data
-- =============================================================================

CREATE OR REPLACE FUNCTION get_free_signups_with_activity(
    date_from TIMESTAMPTZ,
    date_to TIMESTAMPTZ
)
RETURNS TABLE (
    user_id UUID,
    has_activity BOOLEAN,
    viewed_pricing BOOLEAN,
    is_converted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH signups AS (
        -- Get all personal accounts created in date range
        SELECT
            a.primary_owner_user_id as uid,
            a.id as account_id
        FROM basejump.accounts a
        WHERE a.created_at >= date_from
          AND a.created_at <= date_to
          AND a.personal_account = true
    ),
    activity AS (
        -- Check which signups have any agent runs (tried the product)
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN threads t ON t.account_id = s.account_id
        JOIN agent_runs ar ON ar.thread_id = t.thread_id
    ),
    pricing AS (
        -- Check which signups viewed pricing
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN pricing_views pv ON pv.user_id = s.uid
    ),
    conversions AS (
        -- Check which signups converted to paid tier
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN credit_accounts ca ON ca.account_id = s.account_id
        WHERE ca.tier NOT IN ('free', 'none')
    )
    SELECT
        s.uid as user_id,
        EXISTS (SELECT 1 FROM activity a WHERE a.uid = s.uid) as has_activity,
        EXISTS (SELECT 1 FROM pricing p WHERE p.uid = s.uid) as viewed_pricing,
        EXISTS (SELECT 1 FROM conversions c WHERE c.uid = s.uid) as is_converted
    FROM signups s;
END;
$$;
