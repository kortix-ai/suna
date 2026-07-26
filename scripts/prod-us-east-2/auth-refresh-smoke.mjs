#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const requiredEnvironment = [
  "SOURCE_DATABASE_URL",
  "SOURCE_SUPABASE_URL",
  "SOURCE_ANON_KEY",
  "TARGET_DATABASE_URL",
  "TARGET_SUPABASE_URL",
  "TARGET_ANON_KEY",
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (process.env.ALLOW_SOURCE_AUTH_REFRESH_SMOKE !== "1") {
  throw new Error("Set ALLOW_SOURCE_AUTH_REFRESH_SMOKE=1");
}

const sourceDatabaseUrl = process.env.SOURCE_DATABASE_URL;
const sourceUrl = process.env.SOURCE_SUPABASE_URL.replace(/\/+$/, "");
const sourceAnonKey = process.env.SOURCE_ANON_KEY;
const targetDatabaseUrl = process.env.TARGET_DATABASE_URL;
const targetUrl = process.env.TARGET_SUPABASE_URL.replace(/\/+$/, "");
const targetAnonKey = process.env.TARGET_ANON_KEY;
const smokeUserId = randomUUID();
const smokeIdentityId = randomUUID();
const smokeEmail =
  `refresh-compat-${Date.now()}-${smokeUserId.slice(0, 8)}` +
  "@invalid.kortix.test";
const smokePassword = `${randomBytes(24).toString("base64url")}aA1!`;
const variables = {
  user_id: smokeUserId,
  identity_id: smokeIdentityId,
  email: smokeEmail,
  password: smokePassword,
};

const result = {
  sourcePasswordLogin: false,
  sourceRowsReplicated: false,
  targetRefreshToken: false,
  targetUserEndpoint: false,
  sourceTokenAlg: null,
  sourceTokenKid: null,
  targetTokenAlg: null,
  targetTokenKid: null,
  targetSequenceReserved: false,
  cleanupSourceRows: null,
  cleanupTargetRows: null,
  error: null,
};

let sourceInserted = false;

function sql(databaseUrl, input, values = {}) {
  const args = [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(values)) {
    args.push("-v", `${name}=${value}`);
  }

  const command = spawnSync("psql", args, {
    input,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: "10",
      PGOPTIONS: "-c statement_timeout=15000",
    },
  });

  if (command.error) throw command.error;
  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || "psql failed");
  }
  return command.stdout.trim();
}

function authRowCount(databaseUrl) {
  return Number(
    sql(
      databaseUrl,
      `
SELECT
  (SELECT count(*) FROM auth.users WHERE id = :'user_id'::uuid) +
  (SELECT count(*) FROM auth.identities WHERE user_id = :'user_id'::uuid) +
  (SELECT count(*) FROM auth.sessions WHERE user_id = :'user_id'::uuid) +
  (SELECT count(*) FROM auth.refresh_tokens WHERE user_id = :'user_id');
`,
      variables,
    ),
  );
}

function decodeJwtHeader(token) {
  return JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
  );
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      body.error_description ??
      body.msg ??
      body.message ??
      body.error ??
      Object.keys(body).join(",");
    throw new Error(`HTTP ${response.status}: ${detail || "unknown error"}`);
  }
  return body;
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  // Source writers advance this sequence while logical replication copies rows.
  // Reserve a target-only range so the target refresh does not reuse a source ID.
  sql(
    targetDatabaseUrl,
    `
SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1) + 1000000,
  true
);
`,
  );
  result.targetSequenceReserved = true;

  // Insert the source user directly with replica trigger behavior. This avoids
  // invoking the production welcome-email trigger. GoTrue creates the genuine
  // session and refresh token through the password login below.
  sql(
    sourceDatabaseUrl,
    `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  created_at, updated_at, is_sso_user, is_anonymous
) VALUES (
  '00000000-0000-0000-0000-000000000000', :'user_id'::uuid,
  'authenticated', 'authenticated', :'email',
  extensions.crypt(:'password', extensions.gen_salt('bf')),
  now(), '', '', '', '', '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"kortix_migration_refresh_smoke":true}'::jsonb,
  false, now(), now(), false, false
);
INSERT INTO auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) VALUES (
  :'identity_id'::uuid, :'user_id', :'user_id'::uuid,
  jsonb_build_object(
    'sub', :'user_id',
    'email', :'email',
    'email_verified', true
  ),
  'email', now(), now(), now()
);
COMMIT;
`,
    variables,
  );
  sourceInserted = true;

  const sourceLoginResponse = await fetch(
    `${sourceUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: sourceAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: smokeEmail,
        password: smokePassword,
      }),
    },
  );
  const sourceTokens = await responseJson(sourceLoginResponse);
  if (!sourceTokens.access_token || !sourceTokens.refresh_token) {
    throw new Error("Source login omitted access or refresh token");
  }
  result.sourcePasswordLogin = true;
  const sourceHeader = decodeJwtHeader(sourceTokens.access_token);
  result.sourceTokenAlg = sourceHeader.alg ?? null;
  result.sourceTokenKid = sourceHeader.kid ?? null;
  variables.refresh_token = sourceTokens.refresh_token;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const targetState = Number(
      sql(
        targetDatabaseUrl,
        `
SELECT
  (SELECT count(*) FROM auth.users WHERE id = :'user_id'::uuid) +
  (SELECT count(*) FROM auth.sessions WHERE user_id = :'user_id'::uuid) +
  (
    SELECT count(*)
    FROM auth.refresh_tokens
    WHERE user_id = :'user_id'
      AND token = :'refresh_token'
  );
`,
        variables,
      ),
    );
    if (targetState === 3) {
      result.sourceRowsReplicated = true;
      break;
    }
    await sleep(1_000);
  }
  if (!result.sourceRowsReplicated) {
    throw new Error("Source login state did not reach target in 60 seconds");
  }

  const targetRefreshResponse = await fetch(
    `${targetUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        apikey: targetAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: sourceTokens.refresh_token }),
    },
  );
  const targetTokens = await responseJson(targetRefreshResponse);
  if (!targetTokens.access_token || !targetTokens.refresh_token) {
    throw new Error("Target refresh omitted access or refresh token");
  }
  result.targetRefreshToken = true;
  const targetHeader = decodeJwtHeader(targetTokens.access_token);
  result.targetTokenAlg = targetHeader.alg ?? null;
  result.targetTokenKid = targetHeader.kid ?? null;

  const targetPayload = JSON.parse(
    Buffer.from(targetTokens.access_token.split(".")[1], "base64url").toString(
      "utf8",
    ),
  );
  if (targetPayload.sub !== smokeUserId) {
    throw new Error("Target refresh returned a token for another user");
  }

  const targetUserResponse = await fetch(`${targetUrl}/auth/v1/user`, {
    headers: {
      apikey: targetAnonKey,
      Authorization: `Bearer ${targetTokens.access_token}`,
    },
  });
  const targetUser = await responseJson(targetUserResponse);
  if (targetUser.id !== smokeUserId) {
    throw new Error("Target user endpoint returned another user");
  }
  result.targetUserEndpoint = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (sourceInserted) {
      sql(
        sourceDatabaseUrl,
        `
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM auth.refresh_tokens WHERE user_id = :'user_id';
DELETE FROM auth.sessions WHERE user_id = :'user_id'::uuid;
DELETE FROM auth.identities WHERE user_id = :'user_id'::uuid;
DELETE FROM auth.users WHERE id = :'user_id'::uuid;
COMMIT;
`,
        variables,
      );
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (authRowCount(targetDatabaseUrl) <= 1) break;
      await sleep(1_000);
    }

    sql(
      targetDatabaseUrl,
      `
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM auth.refresh_tokens WHERE user_id = :'user_id';
DELETE FROM auth.sessions WHERE user_id = :'user_id'::uuid;
DELETE FROM auth.identities WHERE user_id = :'user_id'::uuid;
DELETE FROM auth.users WHERE id = :'user_id'::uuid;
SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1),
  EXISTS (SELECT 1 FROM auth.refresh_tokens)
);
COMMIT;
`,
      variables,
    );

    result.cleanupSourceRows = authRowCount(sourceDatabaseUrl);
    result.cleanupTargetRows = authRowCount(targetDatabaseUrl);
  } catch (cleanupError) {
    const detail =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    result.error = result.error
      ? `${result.error}; cleanup: ${detail}`
      : `cleanup: ${detail}`;
  }
}

console.log(JSON.stringify(result, null, 2));
if (result.error) process.exit(1);
