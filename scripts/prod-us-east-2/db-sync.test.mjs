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
