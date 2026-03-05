DROP TABLE IF EXISTS user_presence CASCADE;

DROP FUNCTION IF EXISTS update_user_presence_timestamp() CASCADE;
DROP FUNCTION IF EXISTS cleanup_stale_presence() CASCADE;
