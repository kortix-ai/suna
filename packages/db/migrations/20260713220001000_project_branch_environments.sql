DROP INDEX "kortix"."idx_projects_account_repo";

CREATE INDEX "idx_projects_account_repo"
  ON "kortix"."projects" USING btree ("account_id", "repo_url");

ALTER TABLE "kortix"."project_group_grants"
  DROP COLUMN "default_base_ref";
