-- Handle notification_settings: rename user_id to account_id only if user_id exists
DO $$
BEGIN
    -- Check if user_id column exists and needs to be renamed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'notification_settings' 
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE notification_settings DROP CONSTRAINT IF EXISTS notification_settings_user_id_fkey;
        ALTER TABLE notification_settings DROP CONSTRAINT IF EXISTS notification_settings_pkey;
        ALTER TABLE notification_settings RENAME COLUMN user_id TO account_id;
    END IF;
    
    -- Ensure primary key and foreign key exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.notification_settings'::regclass 
        AND contype = 'p'
    ) THEN
        ALTER TABLE notification_settings ADD PRIMARY KEY (account_id);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.notification_settings'::regclass 
        AND conname = 'notification_settings_account_id_fkey'
    ) THEN
        ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_account_id_fkey 
            FOREIGN KEY (account_id) REFERENCES basejump.accounts(id) ON DELETE CASCADE;
    END IF;
END $$;

DROP POLICY IF EXISTS "Users can manage own notification settings" ON notification_settings;
DROP POLICY IF EXISTS "Account members can manage notification settings" ON notification_settings;
CREATE POLICY "Account members can manage notification settings"
    ON notification_settings FOR ALL
    USING (basejump.has_role_on_account(account_id));

-- Handle device_tokens: rename user_id to account_id only if user_id exists
DO $$
BEGIN
    -- Check if user_id column exists and needs to be renamed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'device_tokens' 
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_user_id_fkey;
        ALTER TABLE device_tokens RENAME COLUMN user_id TO account_id;
        ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_user_id_device_token_key;
    END IF;
    
    -- Ensure unique constraint exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.device_tokens'::regclass 
        AND conname = 'device_tokens_account_id_device_token_key'
    ) THEN
        ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_account_id_device_token_key 
            UNIQUE(account_id, device_token);
    END IF;
    
    -- Ensure foreign key exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.device_tokens'::regclass 
        AND conname = 'device_tokens_account_id_fkey'
    ) THEN
        ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_account_id_fkey 
            FOREIGN KEY (account_id) REFERENCES basejump.accounts(id) ON DELETE CASCADE;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_device_tokens_user_id;
CREATE INDEX IF NOT EXISTS idx_device_tokens_account_id ON device_tokens(account_id);

DROP INDEX IF EXISTS idx_device_tokens_active;
CREATE INDEX IF NOT EXISTS idx_device_tokens_active ON device_tokens(account_id, is_active) WHERE is_active = true;

DROP POLICY IF EXISTS "Users can manage own device tokens" ON device_tokens;
DROP POLICY IF EXISTS "Account members can manage device tokens" ON device_tokens;
CREATE POLICY "Account members can manage device tokens"
    ON device_tokens FOR ALL
    USING (basejump.has_role_on_account(account_id));
