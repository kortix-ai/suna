-- Read-only inventory of references to the four observed legacy identities.
-- Invoke through psql with production DATABASE_URL. No rows are modified.
SELECT format(
  'SELECT %L AS table_name, %L AS column_name, count(*)::bigint AS rows FROM %I.%I WHERE %I IN (%L::uuid,%L::uuid,%L::uuid,%L::uuid) HAVING count(*) > 0;',
  table_schema || '.' || table_name,
  column_name,
  table_schema,
  table_name,
  column_name,
  '390dc4bb-00dc-4f64-831a-9240a20e5754', -- chunt
  '1d77603c-e59b-4d61-bb5f-172823b38b5c', -- pmcatee
  'd6f73c99-397f-4d72-9d56-9a59f16d108a', -- swong
  'c88dd96d-d224-4e08-8c77-f80c08023894'  -- uvanajarenukaprasad
)
FROM information_schema.columns
WHERE table_schema IN ('kortix', 'public', 'basejump')
  AND data_type = 'uuid'
  AND column_name ~* '(user|owner|created_by|actor|principal|invited_by|granted_by|member|account_id)'
ORDER BY table_schema, table_name, column_name
\gexec
