import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("./db-sync.sh", import.meta.url),
  "utf8",
);

const functionBody = (name, nextName) => {
  const match = script.match(
    new RegExp(
      `\\n${name}\\(\\) \\{([\\s\\S]*?)\\n\\}\\n\\n${nextName}\\(\\) \\{`,
    ),
  );
  assert.ok(match, `Missing ${name} function`);
  return match[1];
};

test("operator can override the target database endpoint", () => {
  assert.match(
    script,
    /target_database_url="\$\{TARGET_DATABASE_URL_OVERRIDE:-\$\(jq -er '\.target_database_url' <<<"\$target_secret_json"\)\}"/,
  );
});

test("only source preparation requires the Supabase CLI", () => {
  const globalRequirements = script.match(
    /for command_name in ([^;]+); do\n  require_command "\$command_name"\ndone/,
  );
  assert.ok(globalRequirements, "Missing global command requirements");
  assert.doesNotMatch(globalRequirements[1], /\bsupabase\b/);

  const body = functionBody("prepare_source", "start_subscription");
  assert.match(body, /require_command supabase/);
});

test("reconciliation PL/pgSQL reads psql inputs through transaction settings", () => {
  const functions = [
    functionBody("write_counts", "reconcile_counts"),
    functionBody("write_key_hashes", "write_critical_hashes"),
  ];

  for (const body of functions) {
    assert.match(
      body,
      /set_config\('kortix\.migration_database_side', :'database_side', true\)/,
    );
    assert.match(
      body,
      /set_config\('kortix\.migration_publication', :'publication', true\)/,
    );
    assert.match(
      body,
      /set_config\('kortix\.migration_subscription', :'subscription', true\)/,
    );

    const block = body.match(/DO \$do\$([\s\S]*?)\$do\$;/);
    assert.ok(block, "Missing PL/pgSQL block");

    assert.match(
      block[1],
      /current_setting\('kortix\.migration_database_side'\)/,
    );
    assert.match(
      block[1],
      /current_setting\('kortix\.migration_publication'\)/,
    );
    assert.match(
      block[1],
      /current_setting\('kortix\.migration_subscription'\)/,
    );
    assert.doesNotMatch(
      block[1],
      /:'(?:database_side|publication|subscription)'/,
    );
  }
});

test("shadow repair disables statement timeout and restores the full credit account row", () => {
  const body = functionBody(
    "repair_shadow_mutations",
    "backfill_target_precision_columns",
  );

  assert.match(body, /SET LOCAL statement_timeout = 0;/);
  assert.match(
    body,
    /SELECT \$credit_account_columns FROM kortix\.credit_accounts ORDER BY account_id/,
  );
  assert.match(
    body,
    /CREATE TEMP TABLE repair_credit_accounts AS SELECT %s FROM kortix\.credit_accounts WITH NO DATA/,
  );
  assert.match(body, /attname <> 'account_id'/);
  assert.match(body, /ROW\(%3\$s\) IS DISTINCT FROM ROW\(%2\$s\)/);
  assert.match(body, /balance_precise = source\.balance/);
});

test("shadow repair deletes credit ledger rows that do not exist on the source", () => {
  const body = functionBody(
    "repair_shadow_mutations",
    "backfill_target_precision_columns",
  );

  assert.match(
    body,
    /SELECT id FROM kortix\.credit_ledger ORDER BY id/,
  );
  assert.match(
    body,
    /CREATE TEMP TABLE repair_credit_ledger_ids \(\s*id uuid PRIMARY KEY\s*\)/,
  );
  assert.match(
    body,
    /DELETE FROM kortix\.credit_ledger AS target\s+WHERE NOT EXISTS \(\s+SELECT 1\s+FROM repair_credit_ledger_ids AS source\s+WHERE source\.id = target\.id\s+\)/,
  );
});

test("shadow repair exit trap uses captured cleanup arguments", () => {
  const body = functionBody(
    "repair_shadow_mutations",
    "backfill_target_precision_columns",
  );

  assert.match(
    body,
    /printf -v cleanup_trap 'cleanup_shadow_repair %q %q'/,
  );
  assert.match(body, /trap "\$cleanup_trap" EXIT/);
  assert.doesNotMatch(body, /subscription_disabled/);
});

test("precision backfill enables replica triggers and verifies all four tables", () => {
  const body = functionBody("backfill_target_precision_columns", "write_counts");

  assert.match(body, /ENABLE ALWAYS TRIGGER sync_credit_account_precision_columns/);
  assert.match(body, /ENABLE ALWAYS TRIGGER sync_credit_ledger_precision_columns/);
  assert.match(body, /ENABLE ALWAYS TRIGGER sync_gateway_request_log_cost_precision/);
  assert.match(body, /ENABLE ALWAYS TRIGGER sync_usage_event_cost_precision/);
  assert.match(body, /'kortix\.credit_accounts' AS relation/);
  assert.match(body, /'kortix\.credit_ledger'/);
  assert.match(body, /'kortix\.gateway_request_logs'/);
  assert.match(body, /'kortix\.usage_events'/);
});
