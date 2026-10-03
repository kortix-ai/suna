import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

test("US shadow deploy accepts an immutable candidate image tag", () => {
  assert.match(shadowWorkflow, /image_tag:\s*\n\s*description:/);
  assert.match(
    shadowWorkflow,
    /IMAGE_TAG: \$\{\{ inputs\.image_tag \|\| inputs\.version \}\}/,
  );
  assert.match(
    shadowWorkflow,
    /"kortix\/kortix-api:\$\{IMAGE_TAG\}"/,
  );
  assert.match(
    shadowWorkflow,
    /"kortix\/kortix-gateway:\$\{IMAGE_TAG\}"/,
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

test("frontend smoke uses one Playwright installation", () => {
  assert.equal(
    existsSync(new URL("../../tests/e2e/package.json", import.meta.url)),
    false,
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

// psql stub that reproduces the contract the smoke depends on: unaligned
// output separates fields with `|` unless psql gets an explicit `-F`.
const psqlStub = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_PSQL_LOG, JSON.stringify(args) + "\n");
const input = readFileSync(0, "utf8");
const separator = args.includes("-F") ? args[args.indexOf("-F") + 1] : "|";

let row = "";
if (/storage\.objects\.name/.test(input)) {
  row = [process.env.MOCK_OBJECT_NAME, "f"].join(separator);
} else if (/json_agg/.test(input)) {
  row = "[]";
} else if (/json_build_object/.test(input)) {
  row = "{}";
} else if (/backend_url/.test(input)) {
  row = "https://webhook.example.test/hook";
} else if (/count\(\*\) FROM auth\.users/.test(input)) {
  row = "1";
} else if (/last_value/.test(input)) {
  row = "1000";
}
process.stdout.write(row);
`;

// Child harness: stubs the HTTP boundary the smoke drives, then runs the real
// program. The mock storage API only signs the one object that exists, so a
// truncated object name fails the smoke exactly like the real service would.
const fetchHarness = String.raw`import { appendFileSync } from "node:fs";

const userId = process.env.MOCK_USER_ID;
const objectName = process.env.MOCK_OBJECT_NAME;
const targetUrl = process.env.TARGET_SUPABASE_URL;
const redirectTo = process.env.TARGET_FRONTEND_URL + "/auth/callback";
const signPrefix = "/storage/v1/object/sign/avatars/";
const jwt = (claims) =>
  "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const respond = (body, init, requestUrl) => {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: requestUrl });
  return response;
};
const reply = (body, status = 200, requestUrl = "") =>
  respond(JSON.stringify(body), { status }, requestUrl);

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  const method = (init.method || "GET").toUpperCase();
  appendFileSync(
    process.env.MOCK_HTTP_LOG,
    JSON.stringify({ method, pathname: url.pathname }) + "\n",
  );
  const requestUrl = url.toString();
  const path = url.pathname;
  if (path === "/auth/v1/authorize") {
    const host =
      url.searchParams.get("provider") === "google"
        ? "accounts.google.com"
        : "github.com";
    const location =
      "https://" +
      host +
      "/oauth?redirect_to=" +
      encodeURIComponent(redirectTo) +
      "&redirect_uri=" +
      encodeURIComponent(targetUrl + "/auth/v1/callback");
    return respond(null, { status: 302, headers: { location } }, requestUrl);
  }
  if (path === "/auth/v1/admin/users" && method === "POST") {
    return reply({ id: userId }, 200, requestUrl);
  }
  if (path === "/auth/v1/admin/users/" + userId && method === "DELETE") {
    return respond(null, { status: 204 }, requestUrl);
  }
  if (path === "/auth/v1/token") {
    return reply({ access_token: jwt({ aal: "aal1", sub: userId }) }, 200, requestUrl);
  }
  if (path === "/auth/v1/user") {
    return reply({ id: userId }, 200, requestUrl);
  }
  if (path === "/v1/user-roles") {
    return reply({ isAdmin: false }, 200, requestUrl);
  }
  if (path === "/auth/v1/recover") {
    return reply({}, 200, requestUrl);
  }
  if (path === "/auth/v1/factors") {
    return reply(
      { id: "factor-1", totp: { secret: "JBSWY3DPEHPK3PXP" } },
      200,
      requestUrl,
    );
  }
  if (path === "/auth/v1/factors/factor-1/challenge") {
    return reply({ id: "challenge-1" }, 200, requestUrl);
  }
  if (path === "/auth/v1/factors/factor-1/verify") {
    return reply({ access_token: jwt({ aal: "aal2" }) }, 200, requestUrl);
  }
  if (method === "POST" && path.startsWith(signPrefix)) {
    const requested = decodeURIComponent(path.slice(signPrefix.length));
    if (requested === objectName) {
      return reply(
        { signedURL: path.slice("/storage/v1".length) + "?token=t" },
        200,
        requestUrl,
      );
    }
    return reply({ message: "object not found" }, 404, requestUrl);
  }
  if (method === "GET" && path.startsWith(signPrefix)) {
    return respond(
      "avatar-bytes",
      { status: 200, headers: { "content-length": "12" } },
      requestUrl,
    );
  }
  return reply({ message: "unmatched " + method + " " + path }, 500, requestUrl);
};

await import(process.env.MOCK_SCRIPT_URL);
`;

test("storage smoke signs the full object name when it contains the default psql separator", () => {
  const objectName = "avatars/smoke|pipe.png";
  const stubDir = mkdtempSync(join(tmpdir(), "target-smoke-separator-"));
  const psqlLog = join(stubDir, "psql-argv.log");
  const httpLog = join(stubDir, "http-requests.log");
  writeFileSync(join(stubDir, "psql"), psqlStub, { mode: 0o755 });

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", fetchHarness],
    {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        TARGET_DATABASE_URL: "postgresql://smoke-mock/db",
        TARGET_SUPABASE_URL: "http://smoke-mock.test",
        TARGET_ANON_KEY: "anon-key",
        TARGET_SERVICE_ROLE_KEY: "service-role-key",
        TARGET_API_URL: "http://smoke-mock.test",
        TARGET_FRONTEND_URL: "http://smoke-mock.test",
        TARGET_AUTH_SEQUENCE_HEADROOM: "10",
        KEEP_TARGET_AUTH_SEQUENCE_HEADROOM: "0",
        MOCK_USER_ID: randomUUID(),
        MOCK_OBJECT_NAME: objectName,
        MOCK_HTTP_LOG: httpLog,
        MOCK_PSQL_LOG: psqlLog,
        MOCK_SCRIPT_URL: new URL(
          "./target-smoke.mjs",
          import.meta.url,
        ).toString(),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.equal(
    child.status,
    0,
    `smoke failed: ${child.stderr.trim() || child.error}`,
  );
  const result = JSON.parse(child.stdout);
  assert.equal(result.signedAvatar, true);

  const requests = readFileSync(httpLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const signRequest = requests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.startsWith("/storage/v1/object/sign/avatars/"),
  );
  const signedName = decodeURIComponent(
    signRequest.pathname.slice("/storage/v1/object/sign/avatars/".length),
  );
  assert.equal(signedName, objectName);

  const psqlInvocations = readFileSync(psqlLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(psqlInvocations.length > 0);
  for (const args of psqlInvocations) {
    assert.ok(
      args.includes("-F") && args[args.indexOf("-F") + 1] === "\t",
      `psql invoked without an explicit tab separator: ${JSON.stringify(args)}`,
    );
  }
});
