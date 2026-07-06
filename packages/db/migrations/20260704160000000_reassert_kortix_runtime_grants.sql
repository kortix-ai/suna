-- Reassert runtime grants for the direct API DATABASE_URL role plus the
-- Supabase JWT roles. Prod drift showed the API connecting as postgres but
-- failing with 42501 on kortix.oauth_clients and credit RPC fallback paths.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['postgres', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA kortix TO %I', role_name);
      EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA kortix TO %I', role_name);
      EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA kortix TO %I', role_name);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT ALL PRIVILEGES ON TABLES TO %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT ALL PRIVILEGES ON SEQUENCES TO %I', role_name);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA kortix TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA kortix TO authenticated;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA kortix TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT USAGE ON SCHEMA kortix TO anon;
    GRANT SELECT ON ALL TABLES IN SCHEMA kortix TO anon;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA kortix TO anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT ON TABLES TO anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT USAGE, SELECT ON SEQUENCES TO anon;
  END IF;
END
$$;
