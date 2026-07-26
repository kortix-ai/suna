import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("./node-pg-database-url.mjs", import.meta.url);

function run(databaseUrl) {
  return spawnSync(process.execPath, [scriptUrl.pathname], {
    env: databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
}

test("adds Node libpq compatibility without changing the connection target", () => {
  const input =
    "postgresql://postgres.example:password@db.example.test:5432/postgres" +
    "?sslmode=require&application_name=shadow";
  const result = run(input);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");

  const transformed = new URL(result.stdout);
  assert.equal(transformed.protocol, "postgresql:");
  assert.equal(transformed.username, "postgres.example");
  assert.equal(transformed.password, "password");
  assert.equal(transformed.hostname, "db.example.test");
  assert.equal(transformed.port, "5432");
  assert.equal(transformed.pathname, "/postgres");
  assert.equal(transformed.searchParams.get("sslmode"), "require");
  assert.equal(transformed.searchParams.get("application_name"), "shadow");
  assert.equal(transformed.searchParams.get("uselibpqcompat"), "true");
});

test("replaces an incorrect compatibility value", () => {
  const result = run(
    "postgres://postgres:password@db.example.test/postgres" +
      "?sslmode=verify-full&uselibpqcompat=false",
  );

  assert.equal(result.status, 0);
  const transformed = new URL(result.stdout);
  assert.equal(transformed.searchParams.get("sslmode"), "verify-full");
  assert.equal(transformed.searchParams.get("uselibpqcompat"), "true");
});

test("rejects a missing database URL", () => {
  const result = run(undefined);

  assert.equal(result.status, 64);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("rejects a non-Postgres URL", () => {
  const result = run("https://db.example.test/postgres");

  assert.equal(result.status, 64);
  assert.match(result.stderr, /postgres or postgresql protocol/);
});
