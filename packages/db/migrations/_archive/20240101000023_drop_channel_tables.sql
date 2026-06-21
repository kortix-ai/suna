-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║  Drop legacy channel_configs table and channel_type enum.               ║
-- ║  Channels v2 uses sandbox-local SQLite managed by kchannel CLI.         ║
-- ╚════════════════════════════════════════════════════════════════════════════╝

DROP TABLE IF EXISTS kortix.channel_configs CASCADE;
DROP TYPE IF EXISTS kortix.channel_type CASCADE;
