BEGIN;

CREATE TABLE user_mcp_credential_profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    mcp_qualified_name TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    encrypted_config TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    
    UNIQUE(account_id, mcp_qualified_name, profile_name),
    CONSTRAINT fk_credential_profiles_account 
        FOREIGN KEY (account_id) 
        REFERENCES auth.users(id) 
        ON DELETE CASCADE
);

CREATE INDEX idx_credential_profiles_account_mcp 
    ON user_mcp_credential_profiles(account_id, mcp_qualified_name);

CREATE INDEX idx_credential_profiles_account_active 
    ON user_mcp_credential_profiles(account_id, is_active) 
    WHERE is_active = true;

CREATE INDEX idx_credential_profiles_default 
    ON user_mcp_credential_profiles(account_id, mcp_qualified_name, is_default) 
    WHERE is_default = true;

ALTER TABLE user_mcp_credential_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY credential_profiles_user_access 
    ON user_mcp_credential_profiles 
    FOR ALL 
    USING (auth.uid() = account_id);

ALTER TABLE workflows 
ADD COLUMN mcp_credential_mappings JSONB DEFAULT '{}';

COMMENT ON COLUMN workflows.mcp_credential_mappings IS 
'JSON mapping of MCP qualified names to credential profile IDs. Example: {"github": "profile_id_123", "slack": "profile_id_456"}';

-- Migrate existing credentials if the table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_mcp_credentials') THEN
        INSERT INTO user_mcp_credential_profiles (
            account_id,
            mcp_qualified_name,
            profile_name,
            display_name,
            encrypted_config,
            config_hash,
            is_active,
            is_default,
            created_at,
            updated_at,
            last_used_at
        )
        SELECT 
            account_id,
            mcp_qualified_name,
            'Default' as profile_name,
            COALESCE(display_name, mcp_qualified_name) as display_name,
            encrypted_config,
            config_hash,
            is_active,
            true as is_default,
            created_at,
            updated_at,
            last_used_at
        FROM user_mcp_credentials
        WHERE is_active = true;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION ensure_single_default_profile()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = true THEN
        UPDATE user_mcp_credential_profiles 
        SET is_default = false, updated_at = NOW()
        WHERE account_id = NEW.account_id 
          AND mcp_qualified_name = NEW.mcp_qualified_name 
          AND profile_id != NEW.profile_id
          AND is_default = true;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_ensure_single_default_profile
    BEFORE INSERT OR UPDATE ON user_mcp_credential_profiles
    FOR EACH ROW
    EXECUTE FUNCTION ensure_single_default_profile();

CREATE OR REPLACE FUNCTION update_credential_profile_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_credential_profile_timestamp
    BEFORE UPDATE ON user_mcp_credential_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_credential_profile_timestamp();

COMMIT; 