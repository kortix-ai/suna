-- Migration: Add admin user configuration
-- This migration adds support for marking users as admins in the basejump.config table

BEGIN;

-- Add is_admin column to basejump.config table
ALTER TABLE basejump.config ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
ALTER TABLE basejump.config ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_basejump_config_is_admin ON basejump.config(is_admin);
CREATE INDEX IF NOT EXISTS idx_basejump_config_user_id ON basejump.config(user_id);

-- Add comment
COMMENT ON COLUMN basejump.config.is_admin IS 'Indicates if this user is an admin';
COMMENT ON COLUMN basejump.config.user_id IS 'The user ID this config belongs to';

-- Update the get_config function to handle user-specific configs
CREATE OR REPLACE FUNCTION basejump.get_config()
    RETURNS json AS
$$
DECLARE
    result RECORD;
BEGIN
    SELECT * from basejump.config 
    WHERE user_id = auth.uid() OR user_id IS NULL
    ORDER BY user_id NULLS LAST
    LIMIT 1
    into result;
    
    -- If no user-specific config found, get the default config
    IF result IS NULL THEN
        SELECT * from basejump.config WHERE user_id IS NULL limit 1 into result;
    END IF;
    
    return row_to_json(result);
END;
$$ LANGUAGE plpgsql;

-- Update the is_set function to handle user-specific configs
CREATE OR REPLACE FUNCTION basejump.is_set(field_name text)
    RETURNS boolean AS
$$
DECLARE
    result BOOLEAN;
BEGIN
    EXECUTE format('SELECT %I FROM basejump.config WHERE user_id = $1 OR user_id IS NULL ORDER BY user_id NULLS LAST LIMIT 1', field_name)
    USING auth.uid()
    INTO result;
    
    -- If no user-specific config found, get the default config
    IF result IS NULL THEN
        EXECUTE format('SELECT %I FROM basejump.config WHERE user_id IS NULL LIMIT 1', field_name) INTO result;
    END IF;
    
    return result;
END;
$$ LANGUAGE plpgsql;

COMMIT;
