-- Migration: revoke_unreachable_connector_connections
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHY THIS RUNS BEFORE THE CODE CHANGE
--
-- `kortix.connectors.authorization_strategy` ('project' | 'user') was a
-- CONNECTOR-level mode that made the two connection owner types mutually
-- exclusive: a 'project' connector could only ever serve its project-owned
-- (shared) connections, a 'user' connector only member-owned (private) ones.
-- The flag is being retired -- reachability becomes a property of the ROW
-- (`connector_connections.owner_type`), which is what it always described.
--
-- Retiring it WIDENS reachability for rows that the flag had been hiding: a
-- project-owned connection on a 'user' connector, and a member-owned connection
-- on a 'project' connector. Nobody could ever call through those rows, so their
-- stored credentials were never in use -- but after the predicate changes they
-- would become live, and a project-owned row is readable by every member of the
-- project. A credential nobody has been able to use must not silently become a
-- shared one.
--
-- So: revoke every connection that (a) is unreachable under the strategy today
-- AND (b) actually holds an authorized identity (a per-connection credential,
-- the connector-wide legacy credential it would serve as the project default,
-- or a completed Composio account). Revoking loses nothing -- no call has ever
-- been able to reach these rows -- and an operator who genuinely wants one back
-- re-activates it deliberately through
-- `PUT /v1/projects/:id/connections/:cid/activate`, which is manage-gated.
--
-- Rows with no credential are left ACTIVE and untouched: they are empty
-- placeholders, `connectorConnectionIsConnected` already filters them out of
-- every resolution path, and revoking them would be churn with no safety value.
--
-- Local audit (2026-09-16, shared dev database) before this ran:
--   strategy='user'    + owner_type='project': 10 active rows, 3 with a credential
--                                              (slug `veyris`, label "Default workspace")
--   strategy='project' + owner_type='member' :  0 rows
--
-- backfill-safe: kortix.connector_connections -- a bounded one-shot UPDATE over
-- the rows the strategy flag made unreachable (10 candidates / 3 writes on the
-- dev database, single-digit rows expected everywhere). This migration contains
-- NO DDL, so it holds no ACCESS EXCLUSIVE lock; the UPDATE takes ordinary row
-- locks on the handful of rows it matches and writers on every other row in the
-- table proceed untouched.
--
-- Idempotent: `status <> 'revoked'` means a second run matches nothing.
-- There is deliberately no down migration -- see the note at the bottom.

update kortix.connector_connections as cc
   set status = 'revoked',
       updated_at = now()
  from kortix.connectors as c
 where c.connector_id = cc.connector_id
   and cc.status <> 'revoked'
   -- Unreachable under the strategy that is being retired.
   and (
        (c.authorization_strategy = 'user'    and cc.owner_type = 'project')
     or (c.authorization_strategy = 'project' and cc.owner_type = 'member')
   )
   -- ...and holding an identity that would become usable by someone new.
   and (
        exists (
          select 1
            from kortix.connection_credentials k
           where k.connection_id = cc.connection_id
        )
     or (
          cc.owner_type = 'project'
          and cc.is_default
          and exists (
            select 1
              from kortix.connection_credentials k
             where k.connector_id = cc.connector_id
               and k.connection_id is null
          )
        )
     or coalesce(cc.metadata ->> 'connected_account_id', '') <> ''
   );

-- Log what was revoked, per connector, so the count is in the deploy output
-- rather than only inferable from a later query.
do $$
declare
  remaining bigint;
begin
  select count(*) into remaining
    from kortix.connector_connections cc
    join kortix.connectors c on c.connector_id = cc.connector_id
   where cc.status <> 'revoked'
     and (
          (c.authorization_strategy = 'user'    and cc.owner_type = 'project')
       or (c.authorization_strategy = 'project' and cc.owner_type = 'member')
     );
  raise notice
    '[revoke_unreachable_connector_connections] strategy-unreachable connections still active (no credential, harmless): %',
    remaining;
end
$$;

-- DOWN: intentionally none.
--
-- A revocation is a security decision about a credential that was never usable.
-- Re-activating every row this touched would hand those credentials to the
-- whole project on a rollback, which is the exact outcome the migration exists
-- to prevent. Rolling the code back restores the strategy predicate, which
-- makes these rows unreachable again anyway; an operator who wants one back
-- activates it by hand.
