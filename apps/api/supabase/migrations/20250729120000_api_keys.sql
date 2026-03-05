BEGIN;

-- =====================================================
-- API KEYS TABLE MIGRATION (CORRECTED VERSION)
-- =====================================================
-- Streamlined API keys table for high-performance authentication

-- Enum for API key status
DO $$ BEGIN
    CREATE TYPE api_key_status AS ENUM ('active', 'revoked', 'expired');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create API keys table
CREATE TABLE IF NOT EXISTS api_keys (
    key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key VARCHAR(64) NOT NULL UNIQUE,
    secret_key_hash VARCHAR(64) NOT NULL,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status api_key_status DEFAULT 'active',
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Essential constraints
    CONSTRAINT api_keys_title_not_empty CHECK (LENGTH(TRIM(title)) > 0),
    CONSTRAINT api_keys_public_key_format CHECK (public_key ~ '^pk_[a-zA-Z0-9]{32}$')
);

-- Essential indexes for performance
CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_public_key ON api_keys(public_key);

-- Enable RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- RLS policy with explicit schema qualification (avoids basejump function issues)
CREATE POLICY "Users can manage their own API keys" ON api_keys
    FOR ALL USING (
        account_id IN (
            SELECT wu.account_id 
            FROM basejump.account_user wu 
            WHERE wu.user_id = auth.uid()
        )
    );

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO service_role;

COMMIT; 