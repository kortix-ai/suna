-- Minimal, idempotent seed data for integration tests.
-- Loaded by db-seed.sh after migrations are applied. Keep every insert
-- ON CONFLICT DO NOTHING so the seed can be re-run safely.
--
-- This is intentionally tiny: one account and one platform setting. Extend as
-- integration tests need more fixtures.

INSERT INTO kortix.accounts (account_id, name)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Test Org')
ON CONFLICT (account_id) DO NOTHING;
