CREATE TABLE IF NOT EXISTS user_presence_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    active_thread_id TEXT,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    platform TEXT,
    device_info JSONB DEFAULT '{}',
    client_timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_presence_sessions_account_id ON user_presence_sessions(account_id);
CREATE INDEX idx_user_presence_sessions_thread_id ON user_presence_sessions(active_thread_id);
CREATE INDEX idx_user_presence_sessions_last_seen ON user_presence_sessions(last_seen);
CREATE INDEX idx_user_presence_sessions_account_thread ON user_presence_sessions(account_id, active_thread_id);

CREATE OR REPLACE FUNCTION update_user_presence_sessions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_presence_sessions_updated_at
    BEFORE UPDATE ON user_presence_sessions
    FOR EACH ROW EXECUTE FUNCTION update_user_presence_sessions_timestamp();

ALTER TABLE user_presence_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Account members can manage presence sessions"
    ON user_presence_sessions FOR ALL
    USING (basejump.has_role_on_account(account_id));

CREATE OR REPLACE FUNCTION cleanup_stale_presence_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM user_presence_sessions
    WHERE last_seen < NOW() - INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_thread_viewers(thread_id_param TEXT)
RETURNS TABLE (
    account_id UUID,
    last_seen TIMESTAMPTZ,
    platform TEXT,
    session_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ups.account_id,
        MAX(ups.last_seen) as last_seen,
        MAX(ups.platform) as platform,
        COUNT(ups.session_id) as session_count
    FROM user_presence_sessions ups
    WHERE ups.active_thread_id = thread_id_param
      AND ups.last_seen > NOW() - INTERVAL '2 minutes'
    GROUP BY ups.account_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_account_active_threads(account_id_param UUID)
RETURNS TABLE (
    thread_id TEXT,
    session_count BIGINT,
    last_seen TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ups.active_thread_id as thread_id,
        COUNT(ups.session_id) as session_count,
        MAX(ups.last_seen) as last_seen
    FROM user_presence_sessions ups
    WHERE ups.account_id = account_id_param
      AND ups.active_thread_id IS NOT NULL
      AND ups.last_seen > NOW() - INTERVAL '2 minutes'
    GROUP BY ups.active_thread_id;
END;
$$ LANGUAGE plpgsql;
