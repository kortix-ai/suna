SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'messages' AND indexdef LIKE '%thread_id%type%' ORDER BY indexname;
