-- Migration: account_model_preferences_project_id
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 1/5 of the agent-model-pin project-scoping fix (see the doc
-- comment on accountModelPreferences in packages/db/src/schema/kortix.ts).
-- Purely additive: a nullable column + a NOT VALID FK. Safe on its own --
-- every existing row keeps project_id NULL and trivially satisfies the FK
-- (NULL always satisfies a FK). VALIDATE CONSTRAINT is deferred to the next
-- migration so this one never holds a long validation scan.
--   [x] New column is nullable -- no backfill needed.
--   [x] FK added NOT VALID; VALIDATE CONSTRAINT follows in the next migration.

ALTER TABLE "kortix"."account_model_preferences"
  ADD COLUMN "project_id" uuid;

ALTER TABLE "kortix"."account_model_preferences"
  ADD CONSTRAINT "account_model_preferences_project_id_projects_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id")
  ON DELETE CASCADE NOT VALID;
