ALTER TABLE basejump.accounts ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN DEFAULT TRUE;

ALTER TABLE threads ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_accounts_memory_enabled ON basejump.accounts(id) WHERE memory_enabled = FALSE;
CREATE INDEX IF NOT EXISTS idx_threads_memory_enabled ON threads(thread_id) WHERE memory_enabled = FALSE;

CREATE OR REPLACE FUNCTION get_user_memory_enabled(p_account_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(
        (SELECT memory_enabled FROM basejump.accounts WHERE id = p_account_id),
        TRUE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_thread_memory_enabled(p_thread_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(
        (SELECT memory_enabled FROM threads WHERE thread_id = p_thread_id),
        TRUE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_user_memory_enabled(p_account_id UUID, p_enabled BOOLEAN)
RETURNS VOID AS $$
BEGIN
    UPDATE basejump.accounts SET memory_enabled = p_enabled WHERE id = p_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_thread_memory_enabled(p_thread_id UUID, p_enabled BOOLEAN)
RETURNS VOID AS $$
BEGIN
    UPDATE threads SET memory_enabled = p_enabled WHERE thread_id = p_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_user_memory_enabled TO authenticated;
GRANT EXECUTE ON FUNCTION get_thread_memory_enabled TO authenticated;
GRANT EXECUTE ON FUNCTION set_user_memory_enabled TO authenticated;
GRANT EXECUTE ON FUNCTION set_thread_memory_enabled TO authenticated;
