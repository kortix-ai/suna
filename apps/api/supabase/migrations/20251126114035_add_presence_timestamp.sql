ALTER TABLE user_presence ADD COLUMN IF NOT EXISTS client_timestamp TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_presence_client_timestamp ON user_presence(user_id, client_timestamp);
