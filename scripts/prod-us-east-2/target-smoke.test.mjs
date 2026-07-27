import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const targetSmoke = readFileSync(
  new URL("./target-smoke.sh", import.meta.url),
  "utf8",
);
const targetSmokeProgram = readFileSync(
  new URL("./target-smoke.mjs", import.meta.url),
  "utf8",
);
const frontendSmoke = readFileSync(
  new URL("./frontend-auth-smoke.sh", import.meta.url),
  "utf8",
);
const shadowWorkflow = readFileSync(
  new URL(
    "../../.github/workflows/deploy-prod-us-east-2-shadow.yml",
    import.meta.url,
  ),
  "utf8",
);

test("shadow smokes can bypass the production custom domain before cutover", () => {
  assert.match(
    targetSmoke,
    /TARGET_SUPABASE_URL="\$\{TARGET_SUPABASE_URL_OVERRIDE:-\$\(/,
  );
  assert.match(
    frontendSmoke,
    /target_supabase_url="\$\{TARGET_SUPABASE_URL_OVERRIDE:-\$\(/,
  );
  assert.equal(
    shadowWorkflow.match(
      /TARGET_SUPABASE_URL_OVERRIDE="https:\/\/uhrwvisbqjfxhxjvoofd\.supabase\.co"/g,
    )?.length,
    2,
  );
});

test("US shadow exposes the managed model catalog for runtime verification", () => {
  assert.match(
    shadowWorkflow,
    /\.KORTIX_MANAGED_PROVIDER_ENABLED == "true"/,
  );
});

test("shadow Terraform permits only immutable ECS task-definition replacement", () => {
  assert.match(
    shadowWorkflow,
    /\.address != "module\.api\.aws_ecs_task_definition\.this"[\s\S]*\.change\.actions != \["delete", "create"\]/,
  );
  assert.match(
    shadowWorkflow,
    /\.address != "module\.gateway\.aws_ecs_task_definition\.this"[\s\S]*\.change\.actions != \["create", "delete"\]/,
  );
  assert.match(
    shadowWorkflow,
    /if \[ "\$blocked_destructive_changes" != "0" \]/,
  );
});

test("target smoke removes and counts recovery flow state", () => {
  assert.match(
    targetSmokeProgram,
    /DELETE FROM auth\.flow_state\s+WHERE user_id = :'smoke_user_id'::uuid;/,
  );
  assert.match(
    targetSmokeProgram,
    /'auth\.flow_state',\s+\(SELECT count\(\*\) FROM auth\.flow_state WHERE user_id = :'smoke_user_id'::uuid\)/,
  );
});

test("frontend smoke removes and counts password-recovery flow state", () => {
  assert.match(
    frontendSmoke,
    /DELETE FROM auth\.flow_state\s+WHERE user_id = :'smoke_user_id'::uuid/,
  );
  assert.match(
    frontendSmoke,
    /SELECT count\(\*\) FROM auth\.flow_state\s+WHERE user_id = :'smoke_user_id'::uuid/,
  );
});

test("shadow smokes remove and count target-only billing state", () => {
  for (const smokeProgram of [targetSmokeProgram, frontendSmoke]) {
    assert.match(
      smokeProgram,
      /FROM kortix\.account_members[\s\S]*WHERE user_id = :'smoke_user_id'::uuid/,
    );
    assert.match(
      smokeProgram,
      /DELETE FROM kortix\.credit_ledger\s+WHERE account_id = ANY\(:'smoke_account_ids'::uuid\[\]\);/,
    );
    assert.match(
      smokeProgram,
      /DELETE FROM kortix\.credit_accounts\s+WHERE account_id = ANY\(:'smoke_account_ids'::uuid\[\]\);/,
    );
    assert.match(
      smokeProgram,
      /SELECT count\(\*\) FROM kortix\.credit_ledger\s+WHERE account_id = ANY\(:'smoke_account_ids'::uuid\[\]\)/,
    );
  }
});
