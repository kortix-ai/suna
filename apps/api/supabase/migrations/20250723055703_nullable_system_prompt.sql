ALTER TABLE agents 
ALTER COLUMN system_prompt DROP NOT NULL;

UPDATE agents 
SET system_prompt = NULL 
WHERE metadata->>'is_suna_default' = 'true'; 