CREATE OR REPLACE FUNCTION get_memory_stats(p_account_id UUID)
RETURNS TABLE (
    total_memories BIGINT,
    memories_by_type JSONB,
    oldest_memory TIMESTAMPTZ,
    newest_memory TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH base_stats AS (
        SELECT 
            COUNT(*)::BIGINT AS total,
            MIN(um.created_at) AS oldest,
            MAX(um.created_at) AS newest
        FROM user_memories um
        WHERE um.account_id = p_account_id
    ),
    type_stats AS (
        SELECT COALESCE(jsonb_object_agg(um.memory_type, cnt), '{}'::jsonb) AS by_type
        FROM (
            SELECT um.memory_type, COUNT(*) AS cnt
            FROM user_memories um
            WHERE um.account_id = p_account_id
            GROUP BY um.memory_type
        ) um
    )
    SELECT 
        base_stats.total,
        type_stats.by_type,
        base_stats.oldest,
        base_stats.newest
    FROM base_stats, type_stats;
END;
$$ LANGUAGE plpgsql;
