CREATE TABLE IF NOT EXISTS daily_refresh_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES credit_accounts(account_id) ON DELETE CASCADE,
    refresh_date DATE NOT NULL,
    credits_granted NUMERIC(10, 2) NOT NULL,
    tier TEXT NOT NULL,
    processed_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, refresh_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_refresh_tracking_account_date 
ON daily_refresh_tracking(account_id, refresh_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_refresh_tracking_created 
ON daily_refresh_tracking(created_at DESC);

COMMENT ON TABLE daily_refresh_tracking IS 'Tracks daily credit refresh grants to prevent duplicates - works like renewal_processing table';
COMMENT ON COLUMN daily_refresh_tracking.refresh_date IS 'The date this refresh was for (not necessarily when it was processed)';
