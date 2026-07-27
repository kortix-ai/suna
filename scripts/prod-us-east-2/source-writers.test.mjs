import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceWriters = readFileSync(
  new URL("./source-writers.sh", import.meta.url),
  "utf8",
);
const finalWorkflow = readFileSync(
  new URL(
    "../../.github/workflows/finalize-prod-us-east-2-database.yml",
    import.meta.url,
  ),
  "utf8",
);
const customDomain = readFileSync(
  new URL("./custom-domain.sh", import.meta.url),
  "utf8",
);

test("source freeze requires maintenance and an exact confirmation", () => {
  assert.match(
    sourceWriters,
    /FREEZE_SOURCE_WRITERS_CONFIRM:-}" != "freeze:prod-eu-west-2"/,
  );
  assert.match(sourceWriters, /require_blocking_maintenance/);
  assert.match(sourceWriters, /write_status" != "503"/);
});

test("source freeze covers ECS, EKS, autoscaling, worker flags, and cron", () => {
  assert.match(sourceWriters, /kortix-prod-gateway\|kortix-prod-gateway/);
  assert.match(sourceWriters, /SOURCE_EKS_DEPLOYMENTS=\("kortix-api" "kortix-gateway"\)/);
  assert.match(sourceWriters, /application-autoscaling register-scalable-target/);
  assert.match(sourceWriters, /\.KORTIX_WORKERS_ENABLED = "false"/);
  assert.match(sourceWriters, /cron\.unschedule\(jobid\)/);
});

test("rollback refuses disabled replication or enabled US writers", () => {
  assert.match(sourceWriters, /US writers are enabled\. Refusing to reopen the EU source/);
  assert.match(sourceWriters, /Both target subscriptions must be enabled before EU rollback/);
});

test("final database workflow consumes the source freeze marker", () => {
  assert.match(finalWorkflow, /FREEZE_MARKER_PARAMETER: \/kortix\/prod-use2\/source-freeze/);
  assert.match(finalWorkflow, /action == 'finalize-frozen'/);
  assert.match(finalWorkflow, /repair-shadow-mutations/);
  assert.match(finalWorkflow, /reconcile-counts/);
  assert.match(finalWorkflow, /reconcile-key-hashes/);
  assert.match(finalWorkflow, /reconcile-critical-hashes/);
  assert.match(finalWorkflow, /reconcile-sequences/);
  assert.match(finalWorkflow, /STORAGE_VERIFY_ALL=1/);
  assert.match(finalWorkflow, /disable-subscription/);
});

test("custom-domain transfer requires explicit detach and attach gates", () => {
  assert.match(customDomain, /detach-source:\$\{CUSTOM_HOSTNAME\}/);
  assert.match(customDomain, /attach-target:\$\{CUSTOM_HOSTNAME\}/);
  assert.match(customDomain, /expected_cname="\$\{TARGET_PROJECT_REF\}\.supabase\.co\."/);
  assert.match(customDomain, /supabase domains reverify/);
  assert.match(customDomain, /supabase domains activate/);
});
