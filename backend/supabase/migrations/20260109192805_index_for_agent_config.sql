CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_account_suna_default 
    ON agents(account_id) 
    WHERE metadata->>'is_suna_default' = 'true';