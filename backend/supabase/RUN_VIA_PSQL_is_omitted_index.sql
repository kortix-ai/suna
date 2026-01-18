SET statement_timeout = '0';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_llm_not_omitted 
ON messages(thread_id, created_at ASC) 
WHERE is_llm_message = true AND is_omitted = false;

ANALYZE messages;

SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'messages' 
  AND indexname = 'idx_messages_llm_not_omitted';
