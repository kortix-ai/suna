DO $$ BEGIN
  CREATE TYPE kortix.platform_role AS ENUM ('user', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS kortix.platform_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  role kortix.platform_role NOT NULL DEFAULT 'user',
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kortix' AND table_name = 'platform_user_roles' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE kortix.platform_user_roles RENAME COLUMN user_id TO account_id;
  END IF;
END $$;

DROP INDEX IF EXISTS kortix.idx_platform_user_roles_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_user_roles_account_id
  ON kortix.platform_user_roles (account_id);
CREATE INDEX IF NOT EXISTS idx_platform_user_roles_role
  ON kortix.platform_user_roles (role);

GRANT ALL ON kortix.platform_user_roles TO service_role;
