-- Remove unused tables from schema cleanup
-- Drop dependent tables first, then main tables with CASCADE to handle any remaining dependencies
DROP TABLE IF EXISTS knowledge_base_usage_log CASCADE;
DROP TABLE IF EXISTS knowledge_base_entries CASCADE;
DROP TABLE IF EXISTS trigger_events CASCADE;
DROP TABLE IF EXISTS custom_trigger_providers CASCADE;
