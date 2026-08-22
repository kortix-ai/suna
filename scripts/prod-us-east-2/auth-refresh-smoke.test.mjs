import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wrapperUrl = new URL("./auth-refresh-smoke.sh", import.meta.url);
const smokeScript = readFileSync(
  new URL("./auth-refresh-smoke.mjs", import.meta.url),
  "utf8",
);

test("the wrapper rejects source writes without the explicit gate", () => {
  const result = spawnSync("bash", [wrapperUrl.pathname], {
    env: {
      PATH: process.env.PATH,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /ALLOW_SOURCE_AUTH_REFRESH_SMOKE=1/);
});

test("the smoke bypasses the welcome trigger and cleans both Auth copies", () => {
  const replicaMode = smokeScript.indexOf(
    "SET LOCAL session_replication_role = replica",
  );
  const sourceInsert = smokeScript.indexOf("INSERT INTO auth.users");
  const sourceCleanup = smokeScript.indexOf(
    "DELETE FROM auth.refresh_tokens WHERE user_id = :'user_id'",
    sourceInsert,
  );
  const targetCleanup = smokeScript.indexOf(
    "DELETE FROM auth.refresh_tokens WHERE user_id = :'user_id'",
    sourceCleanup + 1,
  );

  assert.ok(replicaMode >= 0);
  assert.ok(replicaMode < sourceInsert);
  assert.ok(sourceCleanup > sourceInsert);
  assert.ok(targetCleanup > sourceCleanup);
});

test("the smoke reserves and restores the target refresh-token sequence", () => {
  const reservation = smokeScript.indexOf(
    "COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1) + 1000000",
  );
  const targetRefresh = smokeScript.indexOf(
    "/auth/v1/token?grant_type=refresh_token",
    smokeScript.indexOf("sourceTokens.refresh_token"),
  );
  const restoration = smokeScript.lastIndexOf(
    "COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1)",
  );

  assert.ok(reservation >= 0);
  assert.ok(targetRefresh > reservation);
  assert.ok(restoration > targetRefresh);
});
