---
recorded: 2026-09-24T20:10:58Z
incident_date: 2026-09-24
commit: 0e20b80252
---
# Client database roles get no privileged grant; a blanket grant is an open door

**Rule:** Never `GRANT ... ON ALL FUNCTIONS` or `ON ALL TABLES` to `anon`,
`authenticated` or `PUBLIC`. Supabase PostgREST hands those roles to anyone
with the public anon key or their own login JWT. A function that trusts its
arguments (`p_account_id`, `p_amount`) is SECURITY DEFINER-safe only if no
client role can execute it. New functions and tables are born private; grant a
client role one named object, with a reason, when a client really calls it.
**Incident:** the baseline and `20260704160000000_reassert_kortix_runtime_grants`
granted EXECUTE on every `public` function to `authenticated`. On prod, any
signed-up user could call 106 SECURITY DEFINER functions plus the invoker
wallet RPCs: mint or drain credits on any account, delete a user's login,
schedule `pg_net` HTTP jobs, read other users' emails. The anon key read and
wrote `public.documents` (~2.6M rows); on dev it read every `kortix` table.
Found by a codebase audit; locked down by hand on dev, staging and prod at
19:40Z the same day, then migration `20260924194804787_client_role_lockdown`.
**Enforcer:** product flow `SEC-K` calls PostgREST as the anon key and as a
user and requires `42501`; the migration's post-condition aborts if any
privileged function is still client-executable.
