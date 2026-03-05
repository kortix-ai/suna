BEGIN;

-- Fix encrypted_config column type to store base64 strings properly
-- Change from BYTEA to TEXT to avoid encoding issues

-- Only proceed if the table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_mcp_credentials') THEN
        DELETE FROM user_mcp_credentials;
        ALTER TABLE user_mcp_credentials 
        ALTER COLUMN encrypted_config TYPE TEXT;
    END IF;
END $$;

COMMIT; 