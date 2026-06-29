-- Up Migration
--
-- Remove "shadow" account_members rows: self-referential ownerships where
-- user_id == account_id but the user_id is NOT a real auth user. These come
-- from legacy/seed account creation (the account got inserted as its own
-- owner) and surface as a bare UUID in IAM member lists because the email
-- never resolves.
--
-- Narrow + safe: only deletes self-referential rows with no backing auth.users
-- row, so it never touches normal members (user_id != account_id) or legitimate
-- personal-account owners (whose account_id IS a real user's id and therefore
-- DOES exist in auth.users). Guarded on the auth schema existing so it is a
-- no-op in environments where the auth tables aren't present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    DELETE FROM "kortix"."account_members" m
     WHERE m.user_id = m.account_id
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id);
  END IF;
END $$;

-- Down Migration
--
-- Forward-only: the deleted rows were invalid (no backing user), nothing to
-- restore.
SELECT 1;
