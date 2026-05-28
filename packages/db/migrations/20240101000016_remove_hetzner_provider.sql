DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix'
      AND t.typname = 'sandbox_provider'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM kortix.sandboxes
      WHERE provider::text = 'hetzner'
    ) THEN
      RAISE EXCEPTION 'Cannot remove hetzner sandbox provider enum while Hetzner sandboxes still exist';
    END IF;

    ALTER TYPE kortix.sandbox_provider RENAME TO sandbox_provider_old;
    CREATE TYPE kortix.sandbox_provider AS ENUM ('daytona', 'local_docker', 'justavps');

    ALTER TABLE kortix.sandboxes
      ALTER COLUMN provider DROP DEFAULT;

    ALTER TABLE kortix.sandboxes
      ALTER COLUMN provider TYPE kortix.sandbox_provider
      USING provider::text::kortix.sandbox_provider;

    ALTER TABLE kortix.sandboxes
      ALTER COLUMN provider SET DEFAULT 'daytona';

    ALTER TABLE kortix.server_entries
      ALTER COLUMN provider TYPE kortix.sandbox_provider
      USING provider::text::kortix.sandbox_provider;

    ALTER TABLE kortix.pool_resources
      ALTER COLUMN provider TYPE kortix.sandbox_provider
      USING provider::text::kortix.sandbox_provider;

    ALTER TABLE kortix.pool_sandboxes
      ALTER COLUMN provider TYPE kortix.sandbox_provider
      USING provider::text::kortix.sandbox_provider;

    DROP TYPE kortix.sandbox_provider_old;
  END IF;
END $$;
