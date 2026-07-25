#!/usr/bin/env node

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const requiredEnvironment = [
  'TARGET_DATABASE_URL',
  'TARGET_SUPABASE_URL',
  'TARGET_ANON_KEY',
  'TARGET_SERVICE_ROLE_KEY',
  'TARGET_API_URL',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const targetUrl = process.env.TARGET_SUPABASE_URL.replace(/\/+$/, '');
const databaseUrl = process.env.TARGET_DATABASE_URL;
const anonKey = process.env.TARGET_ANON_KEY;
const serviceRoleKey = process.env.TARGET_SERVICE_ROLE_KEY;
const apiUrl = process.env.TARGET_API_URL.replace(/\/+$/, '');
const smokePassword = `${randomBytes(32).toString('base64url')}aA1!`;
const smokeEmail = `migration-smoke-${Date.now()}-${randomUUID().slice(0, 8)}@invalid.kortix.test`;

let smokeUserId = null;
let originalWebhookUrl = null;
let signupWebhookSuppressed = false;

function sql(input, variables = {}) {
  const args = [databaseUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) {
    args.push('-v', `${name}=${value}`);
  }
  const result = spawnSync('psql', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Target SQL failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function request(pathOrUrl, options, expectedStatuses = [200]) {
  const response = await fetch(
    pathOrUrl.startsWith('http') ? pathOrUrl : `${targetUrl}${pathOrUrl}`,
    options,
  );
  if (!expectedStatuses.includes(response.status)) {
    let message = '';
    try {
      const body = await response.json();
      message = body.message ?? body.error_description ?? body.error ?? '';
    } catch {
      message = '';
    }
    throw new Error(
      `HTTP ${response.status} for ${new URL(response.url).pathname}${message ? `: ${message}` : ''}`,
    );
  }
  return response;
}

async function apiRequest(path, accessToken, expectedStatuses = [200]) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'kortix-us-west-2-migration-smoke',
    },
  });
  if (!expectedStatuses.includes(response.status)) {
    let message = '';
    try {
      const body = await response.json();
      message = body.message ?? body.error ?? '';
    } catch {
      message = '';
    }
    throw new Error(
      `API HTTP ${response.status} for ${path}${message ? `: ${message}` : ''}`,
    );
  }
  return response;
}

function adminHeaders() {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'Content-Type': 'application/json',
  };
}

function userHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    apikey: anonKey,
    'Content-Type': 'application/json',
  };
}

function decodeBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = input.toUpperCase().replaceAll('=', '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('TOTP secret contains invalid Base32 data');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, '0');
}

function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Auth response did not return a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

async function removeSmokeData() {
  if (!smokeUserId) return;

  try {
    await request(
      `/auth/v1/admin/users/${encodeURIComponent(smokeUserId)}`,
      { method: 'DELETE', headers: adminHeaders() },
      [200, 204, 404],
    );
  } catch {
    // Continue with direct, smoke-scoped cleanup below.
  }

  sql(
    `
DELETE FROM auth.audit_log_entries
WHERE payload::text LIKE '%' || :'smoke_user_id' || '%';

DELETE FROM kortix.audit_events
WHERE actor_user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.refresh_tokens
WHERE user_id = :'smoke_user_id';

DELETE FROM auth.sessions
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.mfa_factors
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.identities
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.users
WHERE id = :'smoke_user_id'::uuid;

SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1),
  EXISTS (SELECT 1 FROM auth.refresh_tokens)
);
`,
    { smoke_user_id: smokeUserId },
  );
}

async function restoreSignupWebhook() {
  if (!signupWebhookSuppressed) return;
  sql(
    `
UPDATE public.webhook_config
SET backend_url = :'webhook_url'
WHERE id = 1;
`,
    { webhook_url: originalWebhookUrl },
  );
  signupWebhookSuppressed = false;
}

function readSmokeRows() {
  if (!smokeUserId) return {};

  return JSON.parse(
    sql(
      `
SELECT json_build_object(
  'auth.audit_log_entries',
  (
    SELECT count(*)
    FROM auth.audit_log_entries
    WHERE payload::text LIKE '%' || :'smoke_user_id' || '%'
  ),
  'auth.identities',
  (SELECT count(*) FROM auth.identities WHERE user_id = :'smoke_user_id'::uuid),
  'auth.mfa_factors',
  (SELECT count(*) FROM auth.mfa_factors WHERE user_id = :'smoke_user_id'::uuid),
  'auth.refresh_tokens',
  (SELECT count(*) FROM auth.refresh_tokens WHERE user_id = :'smoke_user_id'),
  'auth.sessions',
  (SELECT count(*) FROM auth.sessions WHERE user_id = :'smoke_user_id'::uuid),
  'auth.users',
  (SELECT count(*) FROM auth.users WHERE id = :'smoke_user_id'::uuid),
  'kortix.audit_events',
  (SELECT count(*) FROM kortix.audit_events WHERE actor_user_id = :'smoke_user_id'::uuid)
)::text;
`,
      { smoke_user_id: smokeUserId },
    ),
  );
}

async function run() {
  const result = {
    passwordLogin: false,
    emailRecovery: false,
    apiAuthenticated: false,
    targetSchemaUserVisible: false,
    totpEnrollment: false,
    totpChallenge: false,
    aal2Token: false,
    signedAvatar: false,
    publicAvatar: null,
    cleanupRows: null,
    cleanupByTable: null,
  };

  try {
    sql(`
SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1) + 1000000,
  true
);
`);

    originalWebhookUrl = sql(
      `SELECT backend_url FROM public.webhook_config WHERE id = 1;\n`,
    );
    sql(`
UPDATE public.webhook_config
SET backend_url = ''
WHERE id = 1;
`);
    signupWebhookSuppressed = true;

    const createResponse = await request('/auth/v1/admin/users', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        email: smokeEmail,
        password: smokePassword,
        email_confirm: true,
        user_metadata: { kortix_migration_smoke: true },
      }),
    });
    const created = await createResponse.json();
    smokeUserId = created.id ?? created.user?.id;
    if (!smokeUserId) throw new Error('Auth admin create did not return a user id');

    await restoreSignupWebhook();

    result.targetSchemaUserVisible =
      sql(
        `SELECT count(*) FROM auth.users WHERE id = :'smoke_user_id'::uuid;\n`,
        { smoke_user_id: smokeUserId },
      ) === '1';

    const tokenResponse = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: smokeEmail, password: smokePassword }),
    });
    const tokenBody = await tokenResponse.json();
    const accessToken = tokenBody.access_token;
    if (!accessToken) throw new Error('Password login did not return an access token');
    result.passwordLogin = true;

    const userResponse = await request('/auth/v1/user', {
      headers: userHeaders(accessToken),
    });
    const user = await userResponse.json();
    if (user.id !== smokeUserId) throw new Error('Auth user response returned another user');

    const apiResponse = await apiRequest('/v1/user-roles', accessToken);
    const apiIdentity = await apiResponse.json();
    if (typeof apiIdentity.isAdmin !== 'boolean') {
      throw new Error('API user-roles response omitted isAdmin');
    }
    result.apiAuthenticated = true;

    await request('/auth/v1/recover', {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: smokeEmail }),
    });
    result.emailRecovery = true;

    const enrollResponse = await request('/auth/v1/factors', {
      method: 'POST',
      headers: userHeaders(accessToken),
      body: JSON.stringify({
        friendly_name: 'kortix-us-west-2-migration-smoke',
        factor_type: 'totp',
        issuer: 'Kortix migration smoke',
      }),
    });
    const enrolled = await enrollResponse.json();
    const factorId = enrolled.id;
    const totpSecret = enrolled.totp?.secret;
    if (!factorId || !totpSecret) throw new Error('TOTP enrollment omitted factor data');
    result.totpEnrollment = true;

    const challengeResponse = await request(
      `/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`,
      {
        method: 'POST',
        headers: userHeaders(accessToken),
        body: '{}',
      },
    );
    const challenge = await challengeResponse.json();
    if (!challenge.id) throw new Error('TOTP challenge omitted its id');
    result.totpChallenge = true;

    const verifyResponse = await request(
      `/auth/v1/factors/${encodeURIComponent(factorId)}/verify`,
      {
        method: 'POST',
        headers: userHeaders(accessToken),
        body: JSON.stringify({
          challenge_id: challenge.id,
          code: currentTotp(totpSecret),
        }),
      },
    );
    const verified = await verifyResponse.json();
    result.aal2Token = jwtPayload(verified.access_token).aal === 'aal2';

    const objectRow = sql(`
SELECT
  storage.objects.name,
  storage.buckets.public
FROM storage.objects
JOIN storage.buckets
  ON storage.buckets.id = storage.objects.bucket_id
WHERE storage.objects.bucket_id = 'avatars'
ORDER BY storage.objects.name COLLATE "C"
LIMIT 1;
`);
    const [objectName, bucketPublic] = objectRow.split('|');
    if (!objectName) throw new Error('The target avatars bucket is empty');
    const encodedObjectName = objectName
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const signResponse = await request(
      `/storage/v1/object/sign/avatars/${encodedObjectName}`,
      {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ expiresIn: 60 }),
      },
    );
    const signed = await signResponse.json();
    const signedPath = signed.signedURL ?? signed.signedUrl;
    if (!signedPath) throw new Error('Storage did not return a signed URL');
    const signedUrl = signedPath.startsWith('/object/')
      ? `${targetUrl}/storage/v1${signedPath}`
      : new URL(signedPath, targetUrl).toString();
    const signedResponse = await request(signedUrl, {}, [200]);
    result.signedAvatar = Number(signedResponse.headers.get('content-length') ?? 1) > 0;

    if (bucketPublic === 't') {
      const publicResponse = await request(
        `/storage/v1/object/public/avatars/${encodedObjectName}`,
        {},
        [200],
      );
      result.publicAvatar = Number(publicResponse.headers.get('content-length') ?? 1) > 0;
    }
  } finally {
    await restoreSignupWebhook();
    if (result.apiAuthenticated) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await removeSmokeData();
      result.cleanupByTable = readSmokeRows();
      result.cleanupRows = Object.values(result.cleanupByTable).reduce(
        (total, rowCount) => total + Number(rowCount),
        0,
      );
      if (result.cleanupRows === 0) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    if (smokeUserId) {
      result.cleanupByTable = readSmokeRows();
      result.cleanupRows = Object.values(result.cleanupByTable).reduce(
        (total, rowCount) => total + Number(rowCount),
        0,
      );
    }
  }

  const requiredChecks = [
    result.passwordLogin,
    result.emailRecovery,
    result.apiAuthenticated,
    result.targetSchemaUserVisible,
    result.totpEnrollment,
    result.totpChallenge,
    result.aal2Token,
    result.signedAvatar,
    result.cleanupRows === 0,
  ];
  if (result.publicAvatar !== null) requiredChecks.push(result.publicAvatar);
  if (!requiredChecks.every(Boolean)) {
    throw new Error(`Target smoke failed: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify(result));
}

await run();
