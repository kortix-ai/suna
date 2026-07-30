#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { createKortix } from '../../../packages/sdk/src/index';
import { createAcpClient } from '../../../packages/sdk/src/core/acp/client';
import {
  type AcpSessionController,
  createAcpSessionController,
} from '../../../packages/sdk/src/core/acp/session-controller';
import { buildProjectAcpEndpoint } from '../../../packages/sdk/src/core/session/runtime-transport';
import { apiResult, createApiJsonClient } from '../helpers/http';

type Harness = 'claude' | 'codex' | 'opencode' | 'pi';
type SandboxProvider = 'daytona' | 'platinum' | 'e2b' | 'local-docker';

type Project = {
  project_id: string;
  account_id: string;
  git_origin_url: string;
  metadata: {
    experimental?: Record<string, boolean>;
  };
  experimental: Record<string, boolean>;
  experimental_features: Array<{ key: string; name: string; enabled: boolean }>;
};

type ProjectDetail = {
  config: {
    default_agent: string | null;
    open_code_default_agent?: string | null;
    agents: Array<{
      name: string;
      runtime?: string | null;
      harness?: Harness | null;
      native_agent?: string | null;
    }>;
  };
};

type ProjectSession = {
  session_id: string;
  agent_name: string | null;
  sandbox_provider?: SandboxProvider;
  runtime_transport?: 'acp' | 'rest';
  runtime_harness?: Harness;
  native_agent?: string | null;
  acp_server_id?: string | null;
  acp_session_id?: string | null;
};

type SessionStart = ProjectSession & {
  stage: 'provisioning' | 'starting' | 'ready' | 'failed' | 'stopped';
  retriable: boolean;
  error?: string | null;
  opencode_session_id?: string | null;
  sandbox: {
    status: string;
    external_id: string;
    sandbox_id: string;
  } | null;
};

type HarnessEvidence = {
  harness: Harness;
  project_session_id: string;
  sandbox_id: string;
  sandbox_external_id: string;
  opencode_session_id: string;
  sdk_opencode_session_id: string;
  acp_server_id: string;
  acp_session_id: string;
  markers: string[];
  transcript: string;
  create_to_session_ready_ms: number;
  host_timing: unknown;
  guest_timing: unknown;
};

type SessionCreateError = {
  error?: string;
  code?: string;
};

const repoRoot = resolve(import.meta.dir, '../../..');
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const password = 'AcpMultiHarness123!';
const keepFixture = process.env.E2E_KEEP_ACP_MULTI_HARNESS_FIXTURE === '1';
const readinessOnly = process.env.E2E_ACP_MULTI_HARNESS_READINESS_ONLY === '1';
const assertOpenCodeForkIsolation = process.env.E2E_ACP_OPENCODE_FORK_ISOLATION === '1';
const resultPath = process.env.E2E_ACP_MULTI_HARNESS_RESULT_PATH?.trim() || '';
const reuseProjectId = process.env.E2E_ACP_MULTI_HARNESS_REUSE_PROJECT_ID?.trim() || '';
const reuseUserEmail = process.env.E2E_ACP_MULTI_HARNESS_REUSE_EMAIL?.trim() || '';
const sandboxProvider =
  (process.env.E2E_ACP_MULTI_HARNESS_PROVIDER?.trim() as SandboxProvider | undefined) || undefined;
const runtimeModel = process.env.E2E_ACP_MULTI_HARNESS_MODEL?.trim() || '';
const directOpenAiKey = process.env.E2E_ACP_MULTI_HARNESS_OPENAI_API_KEY?.trim() || '';
const manifest = readFileSync(
  resolve(repoRoot, 'packages/starter/templates/base/kortix.yaml'),
  'utf8',
);
const legacyOpenCodeManifest = `# OpenCode REST compatibility fixture.
kortix_version: 2
default_agent: kortix

project:
  name: OpenCode fork isolation
  description: Disposable OpenCode REST compatibility project.

opencode:
  config_dir: .kortix/opencode

agents:
  kortix:
    connectors: all
    secrets: all
    skills: all
    kortix_cli: all
`;
const api = createApiJsonClient(apiBase);
const supportedHarnesses: Harness[] = ['opencode', 'claude', 'codex', 'pi'];
const requestedHarnesses =
  process.env.E2E_ACP_MULTI_HARNESS_HARNESSES?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
const invalidHarnesses = requestedHarnesses.filter(
  (value) => !supportedHarnesses.includes(value as Harness),
);
assert(invalidHarnesses.length === 0, `Unsupported harnesses: ${invalidHarnesses.join(', ')}`);
const harnesses: Harness[] = assertOpenCodeForkIsolation
  ? ['opencode', 'opencode']
  : requestedHarnesses.length > 0
    ? requestedHarnesses.map((value) => value as Harness)
    : supportedHarnesses;

let userId = '';
let userEmail = '';
let accessToken = '';
let projectId = '';
let accountId = '';
const sessionIds: string[] = [];
const controllers = new Set<AcpSessionController>();

function log(label: string, detail: string): void {
  console.log(`[acp-multi-harness] ${label}: ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createUserAndSignIn(email: string): Promise<string> {
  assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required');
  assert(anonKey, 'SUPABASE_ANON_KEY is required');
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });
  const createdText = await created.text();
  assert(created.status === 200, `Supabase user create returned ${created.status}: ${createdText}`);
  const createdBody = JSON.parse(createdText) as {
    id?: string;
    user?: { id?: string };
  };
  userId = createdBody.user?.id ?? createdBody.id ?? '';
  assert(userId, 'Supabase user create returned no user id');

  return signIn(email);
}

async function signIn(email: string): Promise<string> {
  assert(anonKey, 'SUPABASE_ANON_KEY is required');
  const signedIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const signedInText = await signedIn.text();
  assert(signedIn.status === 200, `Supabase sign-in returned ${signedIn.status}: ${signedInText}`);
  const session = JSON.parse(signedInText) as { access_token?: string };
  assert(session.access_token, 'Supabase sign-in returned no access_token');
  return session.access_token;
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await Bun.sleep(1_000);
    value = await read();
  }
  if (!accept(value)) {
    throw new Error(`${label} timed out: ${JSON.stringify(value).slice(0, 1_000)}`);
  }
  return value;
}

function seedCredits(accountId: string): void {
  if (!databaseUrl) {
    log('credits', 'E2E_DATABASE_URL is unset; using the account state from the API');
    return;
  }
  assert(/^[0-9a-f-]{36}$/i.test(accountId), `invalid account id for credit seed: ${accountId}`);
  const sql = `INSERT INTO kortix.credit_accounts (account_id, balance, tier)
    VALUES ('${accountId}', 1000, 'tier_2_20')
    ON CONFLICT (account_id) DO UPDATE SET balance = 1000, tier = 'tier_2_20';`;
  const result = Bun.spawnSync(['psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert(result.exitCode === 0, `credit seed failed: ${result.stderr.toString().trim()}`);
}

function runGit(args: string[], cwd?: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = result.stderr
    .toString()
    .trim()
    .replace(/https:\/\/[^@\s]+@/g, 'https://[credentials]@');
  assert(result.exitCode === 0, `git ${args[0]} failed: ${stderr}`);
}

async function rewriteProjectAsOpenCodeRestFixture(project: Project, token: string): Promise<void> {
  const checkout = mkdtempSync(resolve(tmpdir(), 'kortix-opencode-rest-fixture-'));
  const credential = await api<{ token_id: string; secret_key: string }>(
    token,
    'POST',
    `/projects/${project.project_id}/cli-token`,
    { name: 'OpenCode REST isolation smoke' },
    201,
  );
  const authenticatedOrigin = new URL(project.git_origin_url);
  authenticatedOrigin.username = 'x-access-token';
  authenticatedOrigin.password = credential.secret_key;
  try {
    runGit(['clone', '--depth', '1', authenticatedOrigin.toString(), checkout]);
    writeFileSync(resolve(checkout, 'kortix.yaml'), legacyOpenCodeManifest);
    runGit(['add', 'kortix.yaml'], checkout);
    runGit(
      [
        '-c',
        'user.name=Kortix E2E',
        '-c',
        'user.email=e2e@kortix.ai',
        'commit',
        '-m',
        'test: use OpenCode REST compatibility manifest',
      ],
      checkout,
    );
    runGit(['push', authenticatedOrigin.toString(), 'HEAD'], checkout);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    const revoked = await apiResult(
      apiBase,
      token,
      'DELETE',
      `/projects/${project.project_id}/cli-token/${credential.token_id}`,
    );
    assert(revoked.status === 200, `temporary project token revoke returned ${revoked.status}`);
  }
}

async function hardDeleteFixtureRows(projectId: string, accountId: string): Promise<void> {
  assert(databaseUrl, 'DATABASE_URL is required for complete fixture cleanup');
  assert(/^[0-9a-f-]{36}$/i.test(projectId), `invalid cleanup project id: ${projectId}`);
  assert(/^[0-9a-f-]{36}$/i.test(accountId), `invalid cleanup account id: ${accountId}`);
  const sql = `BEGIN;
    DELETE FROM kortix.projects WHERE project_id = '${projectId}';
    DELETE FROM kortix.accounts WHERE account_id = '${accountId}';
    COMMIT;`;
  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = Bun.spawnSync(['psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0) return;
    lastError = result.stderr.toString().trim();
    if (
      !lastError.includes('remaining connection slots') &&
      !lastError.includes('too many clients')
    ) {
      break;
    }
    log('cleanup', `database connection unavailable; retrying fixture row cleanup (${attempt}/5)`);
    await Bun.sleep(attempt * 1_000);
  }
  throw new Error(`fixture row cleanup failed: ${lastError}`);
}

function readHostTiming(sessionId: string): unknown {
  if (!databaseUrl) return null;
  assert(/^[0-9a-f-]{36}$/i.test(sessionId), `invalid session id for timing query: ${sessionId}`);
  const sql = `SELECT jsonb_build_object(
      'provider', ss.provider::text,
      'image', ss.metadata -> 'runtimeArtifact',
      'provision_timeline', ss.metadata -> 'provisionTimeline',
      'session_start_timeline', ps.metadata -> 'session_start_timeline'
    )::text
    FROM kortix.session_sandboxes ss
    JOIN kortix.project_sessions ps ON ps.session_id = ss.session_id
    WHERE ss.session_id = '${sessionId}'
    LIMIT 1;`;
  const result = Bun.spawnSync(['psql', databaseUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert(result.exitCode === 0, `timing query failed: ${result.stderr.toString().trim()}`);
  const raw = result.stdout.toString().trim();
  return raw ? JSON.parse(raw) : null;
}

async function readGuestTiming(token: string, externalId: string): Promise<unknown> {
  const response = await fetch(`${apiBase}/p/${externalId}/8000/kortix/health`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  assert(response.ok, `guest timing health returned ${response.status}: ${raw}`);
  const health = JSON.parse(raw) as Record<string, unknown>;
  return {
    runtimeReady: health.runtimeReady,
    runtime_harness: health.runtime_harness,
    boot_timeline: health.boot_timeline,
  };
}

function authorizedFetch(token: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

function assistantProjectionText(controller: AcpSessionController): string {
  return controller
    .getSnapshot()
    .projection.messages.filter((message) => message.info.role === 'assistant')
    .flatMap((message) =>
      message.parts.filter((part) => part.type === 'text').map((part) => part.text),
    )
    .join('\n');
}

function controllerFor(
  token: string,
  sessionId: string,
  start: SessionStart,
): AcpSessionController {
  assert(start.sandbox?.external_id, 'session has no sandbox external_id');
  assert(start.acp_server_id, 'session has no acp_server_id');
  assert(start.acp_session_id, 'session has no acp_session_id');
  assert(start.runtime_harness, 'session has no runtime_harness');
  const client = createAcpClient({
    endpoint: buildProjectAcpEndpoint(apiBase, projectId, sessionId),
    fetch: authorizedFetch(token),
    requestTimeoutMs: 180_000,
  });
  const controller = createAcpSessionController({
    sessionId,
    acpServerId: start.acp_server_id,
    acpSessionId: start.acp_session_id,
    runtimeHarness: start.runtime_harness,
    nativeAgent: start.native_agent,
    durableTranscript: true,
    client,
  });
  controllers.add(controller);
  return controller;
}

async function readSession(token: string, sessionId: string): Promise<ProjectSession> {
  return api<ProjectSession>(token, 'GET', `/projects/${projectId}/sessions/${sessionId}`);
}

async function createSessionAfterManifestConvergence(
  token: string,
  harness: Harness,
  body: Record<string, unknown>,
): Promise<ProjectSession> {
  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await apiResult<ProjectSession & SessionCreateError>(
      apiBase,
      token,
      'POST',
      `/projects/${projectId}/sessions`,
      body,
    );
    if (result.status === 201 && result.json?.session_id) return result.json;

    const isManifestConvergence =
      result.status === 409 && result.json?.code === 'ACP_RUNTIME_REQUIRED';
    if (!isManifestConvergence || attempt === maxAttempts) {
      throw new Error(
        `${harness} session create returned ${result.status}: ${JSON.stringify(result.json)}`,
      );
    }

    log(
      harness,
      `manifest convergence returned 409 ACP_RUNTIME_REQUIRED; retrying create (${attempt}/${maxAttempts})`,
    );
    await Bun.sleep(1_000);
  }
  throw new Error(`${harness} session create exhausted the manifest convergence retry`);
}

async function waitForReady(
  token: string,
  sessionId: string,
  harness: Harness,
): Promise<SessionStart> {
  return waitFor(
    async () => {
      const result = await api<SessionStart>(
        token,
        'POST',
        `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`,
        {},
      );
      if (result.stage === 'failed') {
        throw new Error(`${harness} runtime failed: ${result.error || 'unknown error'}`);
      }
      return result;
    },
    (value) =>
      value.stage === 'ready' &&
      value.sandbox?.status === 'active' &&
      Boolean(value.sandbox.external_id) &&
      (assertOpenCodeForkIsolation
        ? value.runtime_transport === 'rest' && Boolean(value.opencode_session_id)
        : value.runtime_transport === 'acp' &&
          value.runtime_harness === harness &&
          value.acp_server_id === sessionId &&
          Boolean(value.acp_session_id)),
    `${harness} runtime readiness`,
    12 * 60_000,
  );
}

async function readRestTranscript(
  session: ReturnType<ReturnType<typeof createKortix>['session']>,
  openCodeSessionId: string,
): Promise<string> {
  const result = await session.runtime.session.messages({
    sessionID: openCodeSessionId,
  });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  return messages
    .filter((message) => message.info?.role === 'assistant')
    .flatMap((message) =>
      (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? ''),
    )
    .join('\n');
}

async function waitForMarker(
  controller: AcpSessionController,
  marker: string,
  label: string,
): Promise<void> {
  await waitFor(
    async () => assistantProjectionText(controller),
    (text) => text.includes(marker),
    label,
    5 * 60_000,
  );
}

async function verifyHarness(token: string, harness: Harness): Promise<HarnessEvidence> {
  const expectedNativeAgent =
    !assertOpenCodeForkIsolation && harness === 'opencode' ? 'kortix' : null;
  const markerSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const firstMarker = `${harness.toUpperCase()}_FIRST_${markerSuffix}`;
  const secondMarker = `${harness.toUpperCase()}_FOLLOWUP_${markerSuffix}`;
  const restartMarker = `${harness.toUpperCase()}_RESTART_${markerSuffix}`;
  const createStartedAt = performance.now();
  const created = await createSessionAfterManifestConvergence(token, harness, {
    name: `${harness} ACP smoke`,
    agent_name: assertOpenCodeForkIsolation ? 'kortix' : harness,
    ...(!assertOpenCodeForkIsolation
      ? { initial_prompt: `Reply with exactly ${firstMarker}` }
      : {}),
    ...(sandboxProvider ? { provider: sandboxProvider } : {}),
    ...(runtimeModel ? { opencode_model: runtimeModel } : {}),
  });
  const sessionId = created.session_id;
  sessionIds.push(sessionId);
  assert(
    !sandboxProvider || created.sandbox_provider === sandboxProvider,
    `${harness}: sandbox_provider changed`,
  );

  const started = await waitForReady(token, sessionId, harness);
  const sessionReadyMs = Math.round(performance.now() - createStartedAt);
  assert(
    started.agent_name === (assertOpenCodeForkIsolation ? 'kortix' : harness),
    `${harness}: agent_name changed`,
  );
  assert(
    started.native_agent === expectedNativeAgent,
    `${harness}: native_agent was not the immutable manifest value`,
  );
  assert(started.opencode_session_id, `${harness}: /start returned no opencode_session_id`);
  const sdk = createKortix({
    backendUrl: apiBase,
    getToken: async () => token,
  });
  const sdkSession = sdk.session(projectId, sessionId);
  const sdkReady = await sdkSession.ensureReady({ readyTimeoutMs: 180_000 });
  assert(
    sdkReady.opencodeSessionId === started.opencode_session_id,
    `${harness}: public SDK did not preserve the authoritative /start pin`,
  );
  assert(
    sdkReady.sandboxId === started.sandbox?.external_id,
    `${harness}: public SDK resolved a different sandbox`,
  );
  const hostTiming = readHostTiming(sessionId);
  const guestTiming = await readGuestTiming(token, started.sandbox?.external_id ?? '');
  const identity = {
    runtime_transport: started.runtime_transport,
    runtime_harness: started.runtime_harness,
    native_agent: started.native_agent,
    opencode_session_id: started.opencode_session_id,
    acp_server_id: started.acp_server_id,
    acp_session_id: started.acp_session_id,
  };
  log(
    harness,
    `READY create_to_session_ready_ms=${sessionReadyMs} project_session_id=${sessionId} runtime_harness=${identity.runtime_harness}`,
  );
  log(
    harness,
    `TIMING ${JSON.stringify({
      create_to_session_ready_ms: sessionReadyMs,
      host: hostTiming,
      guest: guestTiming,
    })}`,
  );
  const evidenceBase = {
    harness,
    project_session_id: sessionId,
    sandbox_id: started.sandbox?.sandbox_id ?? '',
    sandbox_external_id: started.sandbox?.external_id ?? '',
    opencode_session_id: started.opencode_session_id,
    sdk_opencode_session_id: sdkReady.opencodeSessionId,
    acp_server_id: started.acp_server_id ?? '',
    acp_session_id: started.acp_session_id ?? '',
    markers: [firstMarker, secondMarker, restartMarker],
    create_to_session_ready_ms: sessionReadyMs,
    host_timing: hostTiming,
    guest_timing: guestTiming,
  };
  if (readinessOnly) return { ...evidenceBase, transcript: '' };

  if (assertOpenCodeForkIsolation) {
    const readTranscript = () => readRestTranscript(sdkSession, started.opencode_session_id!);
    await sdkSession.send(`Reply with exactly ${firstMarker}`);
    await waitFor(
      readTranscript,
      (text) => text.includes(firstMarker),
      'OpenCode REST first SDK response',
      5 * 60_000,
    );
    await sdkSession.send(`Reply with exactly ${secondMarker}`);
    await waitFor(
      readTranscript,
      (text) => text.includes(secondMarker),
      'OpenCode REST follow-up response',
      5 * 60_000,
    );

    await sdkSession.restart();
    const restarted = await waitForReady(token, sessionId, harness);
    assert(
      restarted.opencode_session_id === started.opencode_session_id,
      'OpenCode REST root changed after restart',
    );
    const restartedReady = await sdkSession.ensureReady({
      readyTimeoutMs: 180_000,
    });
    assert(
      restartedReady.opencodeSessionId === started.opencode_session_id,
      'Public SDK changed the authoritative OpenCode pin after restart',
    );
    await sdkSession.send(`Reply with exactly ${restartMarker}`);
    const finalTranscript = await waitFor(
      readTranscript,
      (text) =>
        text.includes(firstMarker) && text.includes(secondMarker) && text.includes(restartMarker),
      'OpenCode REST response after restart',
      5 * 60_000,
    );
    log(
      harness,
      `PASS project_session_id=${sessionId} opencode_session_id=${started.opencode_session_id}`,
    );
    return { ...evidenceBase, transcript: finalTranscript };
  }

  const controller = controllerFor(token, sessionId, started);
  await controller.connect();
  await waitForMarker(controller, firstMarker, `${harness} initial headless response`);
  await controller.send([{ type: 'text', text: `Reply with exactly ${secondMarker}` }]);
  await waitForMarker(controller, secondMarker, `${harness} follow-up response`);
  controller.close();
  controllers.delete(controller);

  const reloaded = controllerFor(token, sessionId, started);
  await reloaded.connect();
  const transcript = assistantProjectionText(reloaded);
  assert(
    transcript.includes(firstMarker) && transcript.includes(secondMarker),
    `${harness}: transcript reload did not contain both turns`,
  );
  reloaded.close();
  controllers.delete(reloaded);

  const immutableAttempt = await apiResult<{ error?: string }>(
    apiBase,
    token,
    'PATCH',
    `/projects/${projectId}/sessions/${sessionId}`,
    { agent_name: harness === 'codex' ? 'pi' : 'codex' },
  );
  assert(
    immutableAttempt.status === 400,
    `${harness}: agent_name mutation returned ${immutableAttempt.status}`,
  );

  await api(token, 'POST', `/projects/${projectId}/sessions/${sessionId}/restart`, {}, 202);
  const restarted = await waitForReady(token, sessionId, harness);
  assert(
    restarted.runtime_transport === identity.runtime_transport &&
      restarted.runtime_harness === identity.runtime_harness &&
      restarted.native_agent === identity.native_agent &&
      restarted.opencode_session_id === identity.opencode_session_id &&
      restarted.acp_server_id === identity.acp_server_id &&
      restarted.acp_session_id === identity.acp_session_id,
    `${harness}: runtime identity changed after restart`,
  );

  const afterRestart = controllerFor(token, sessionId, restarted);
  await afterRestart.connect();
  await afterRestart.send([{ type: 'text', text: `Reply with exactly ${restartMarker}` }]);
  await waitForMarker(afterRestart, restartMarker, `${harness} response after restart`);
  const finalTranscript = assistantProjectionText(afterRestart);
  assert(
    finalTranscript.includes(firstMarker) &&
      finalTranscript.includes(secondMarker) &&
      finalTranscript.includes(restartMarker),
    `${harness}: restart transcript lost a turn`,
  );
  afterRestart.close();
  controllers.delete(afterRestart);

  const finalSession = await readSession(token, sessionId);
  assert(
    finalSession.runtime_harness === harness &&
      finalSession.acp_server_id === sessionId &&
      finalSession.acp_session_id === identity.acp_session_id,
    `${harness}: persisted session identity changed`,
  );
  log(
    harness,
    `PASS project_session_id=${sessionId} acp_server_id=${identity.acp_server_id} acp_session_id=${identity.acp_session_id}`,
  );
  return { ...evidenceBase, transcript: finalTranscript };
}

function verifyOpenCodeForkIsolation(evidence: HarnessEvidence[]): void {
  assert(
    evidence.length === 2 && evidence.every((item) => item.harness === 'opencode'),
    'OpenCode fork isolation requires exactly two OpenCode sessions',
  );
  const [first, second] = evidence;
  assert(
    first.project_session_id !== second.project_session_id,
    'OpenCode fork sessions share one Kortix session_id',
  );
  assert(first.sandbox_id !== second.sandbox_id, 'OpenCode fork sessions share one sandbox_id');
  assert(
    first.sandbox_external_id !== second.sandbox_external_id,
    'OpenCode fork sessions share one sandbox external_id',
  );
  if (!readinessOnly) {
    assert(
      second.markers.every((marker) => !first.transcript.includes(marker)),
      'The first OpenCode transcript contains a marker from the second session',
    );
    assert(
      first.markers.every((marker) => !second.transcript.includes(marker)),
      'The second OpenCode transcript contains a marker from the first session',
    );
  }
  log(
    'opencode-fork-isolation',
    `PASS session_a=${first.project_session_id} opencode_a=${first.opencode_session_id} session_b=${second.project_session_id} opencode_b=${second.opencode_session_id} inherited_pin_equal=${first.opencode_session_id === second.opencode_session_id}`,
  );
}

function writeEvidence(evidence: HarnessEvidence[]): void {
  if (!resultPath) return;
  const absolutePath = resolve(repoRoot, resultPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  // lgtm[js/http-to-file-access] This local benchmark artifact contains non-secret API timing and session identity evidence.
  writeFileSync(
    absolutePath,
    `${JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        api_base: apiBase,
        project_id: projectId,
        provider: sandboxProvider ?? null,
        readiness_only: readinessOnly,
        open_code_fork_isolation: assertOpenCodeForkIsolation,
        sessions: evidence,
      },
      null,
      2,
    )}\n`,
  );
  log('evidence', absolutePath);
}

async function main(): Promise<void> {
  log(
    'target',
    `${apiBase} with ${harnesses.join(', ')} on ${sandboxProvider ?? 'the project default provider'} using ${runtimeModel || 'each harness default model'}`,
  );
  assert(
    (reuseProjectId && reuseUserEmail) || (!reuseProjectId && !reuseUserEmail),
    'E2E_ACP_MULTI_HARNESS_REUSE_PROJECT_ID and E2E_ACP_MULTI_HARNESS_REUSE_EMAIL must be set together',
  );
  const email =
    reuseUserEmail || `acp-multi-harness-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  userEmail = email;
  accessToken = reuseProjectId ? await signIn(email) : await createUserAndSignIn(email);
  const token = accessToken;

  if (reuseProjectId) {
    projectId = reuseProjectId;
    log('fixture', `reusing project=${projectId}`);
  } else {
    const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
      token,
      'GET',
      '/accounts',
    );
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    assert(account?.account_id, 'No personal account exists for the smoke user');
    accountId = account.account_id;
    seedCredits(accountId);

    const project = await api<Project>(
      token,
      'POST',
      '/projects/provision',
      {
        account_id: accountId,
        name: `Multi-harness ${Date.now()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    assert(project.account_id === accountId, 'Project response account_id changed');
    assert(project.git_origin_url, 'Project response has no git_origin_url');
    assert(
      Boolean(project.metadata.experimental?.acp_runtime) === true,
      'starter project metadata has an unexpected acp_runtime state',
    );
    assert(
      project.experimental.acp_runtime === true,
      'starter project has an unexpected acp_runtime state',
    );
    assert(
      project.experimental_features.some(
        (feature) =>
          feature.key === 'acp_runtime' &&
          feature.name === 'ACP & Multi-Harness' &&
          feature.enabled === true,
      ),
      'starter project did not expose the expected ACP & Multi-Harness state',
    );
    if (assertOpenCodeForkIsolation) {
      await rewriteProjectAsOpenCodeRestFixture(project, token);
    }

    const seededManifestResult = await waitFor(
      () =>
        apiResult<{ content?: string }>(
          apiBase,
          token,
          'GET',
          `/projects/${projectId}/files/content?path=kortix.yaml`,
        ),
      (value) =>
        value.status === 200 &&
        value.json?.content?.includes(
          `kortix_version: ${assertOpenCodeForkIsolation ? '2' : '3'}`,
        ) === true,
      'seeded ACP multi-harness manifest',
    );
    const seededManifest = seededManifestResult.json;
    assert(seededManifest, 'seeded manifest response has no JSON body');
    const validation = await api<{ valid: boolean; issues: unknown[] }>(
      token,
      'POST',
      `/projects/${projectId}/manifest/validate`,
      { raw: seededManifest.content ?? manifest, format: 'yaml' },
    );
    assert(
      validation.valid && validation.issues.length === 0,
      `manifest validation failed: ${JSON.stringify(validation.issues)}`,
    );
    await api(token, 'POST', `/executor/projects/${projectId}/connectors/sync`, {});
    if (directOpenAiKey) {
      await api(token, 'POST', `/projects/${projectId}/secrets`, {
        name: 'OPENAI_API_KEY',
        value: directOpenAiKey,
      });
      log('credential', 'seeded temporary OPENAI_API_KEY for this disposable fixture');
    }
  }

  const detail = await waitFor(
    () => api<ProjectDetail>(token, 'GET', `/projects/${projectId}/detail`),
    (value) =>
      assertOpenCodeForkIsolation
        ? value.config.agents.some((agent) => agent.name === 'kortix')
        : harnesses.every((harness) =>
            value.config.agents.some(
              (agent) =>
                agent.name === harness && agent.runtime === harness && agent.harness === harness,
            ),
          ),
    'four-agent runtime catalog',
  );
  assert(
    (detail.config.default_agent ?? detail.config.open_code_default_agent) ===
      (assertOpenCodeForkIsolation ? 'kortix' : 'opencode'),
    `unexpected default_agent: ${detail.config.default_agent ?? detail.config.open_code_default_agent}`,
  );

  const enabled =
    reuseProjectId || assertOpenCodeForkIsolation
      ? await api<Project>(token, 'PATCH', `/projects/${projectId}/experimental`, {
          feature: 'acp_runtime',
          enabled: !assertOpenCodeForkIsolation,
        })
      : await api<Project>(token, 'GET', `/projects/${projectId}`);
  assert(
    enabled.experimental.acp_runtime === !assertOpenCodeForkIsolation,
    `acp_runtime did not ${assertOpenCodeForkIsolation ? 'disable' : 'enable'}`,
  );
  assert(
    enabled.experimental_features.some(
      (feature) =>
        feature.key === 'acp_runtime' &&
        feature.name === 'ACP & Multi-Harness' &&
        feature.enabled === !assertOpenCodeForkIsolation,
    ),
    'experimental catalog did not expose the expected ACP & Multi-Harness state',
  );

  const evidence = assertOpenCodeForkIsolation
    ? await Promise.all(harnesses.map((harness) => verifyHarness(token, harness)))
    : await harnesses.reduce<Promise<HarnessEvidence[]>>(
        async (pending, harness) => [...(await pending), await verifyHarness(token, harness)],
        Promise.resolve([]),
      );
  if (assertOpenCodeForkIsolation) verifyOpenCodeForkIsolation(evidence);
  writeEvidence(evidence);
  log('result', `PASS ${harnesses.length}/${harnesses.length} harnesses`);
  log('fixture', `project=${projectId}`);
}

async function cleanup(): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const controller of controllers) controller.close();
  controllers.clear();
  if (keepFixture) {
    log('fixture', `kept project=${projectId} sessions=${sessionIds.join(',')}`);
    log('login', `email=${userEmail} password=${password}`);
  } else if (accessToken && projectId) {
    for (const sessionId of sessionIds) {
      try {
        const stopped = await apiResult(
          apiBase,
          accessToken,
          'DELETE',
          `/projects/${projectId}/sessions/${sessionId}`,
        );
        assert(
          stopped.status === 200 || stopped.status === 404,
          `session cleanup returned ${stopped.status} for ${sessionId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!reuseProjectId) {
      try {
        const purged = await apiResult<{ repo_deleted?: boolean }>(
          apiBase,
          accessToken,
          'DELETE',
          `/projects/${projectId}?purge=true`,
        );
        assert(purged.status === 200, `project purge returned ${purged.status}`);
        assert(purged.json?.repo_deleted === true, 'project purge did not delete the managed repo');
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await hardDeleteFixtureRows(projectId, accountId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (!keepFixture && !reuseProjectId && userId && serviceRoleKey) {
    try {
      const deletedUser = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });
      assert(
        deletedUser.status === 200 || deletedUser.status === 204 || deletedUser.status === 404,
        `Supabase user cleanup returned ${deletedUser.status}: ${await deletedUser.text()}`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!keepFixture && !reuseProjectId && projectId && accountId && cleanupErrors.length === 0)
    log('cleanup', 'removed project, sessions, account, and user');
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'fixture cleanup failed');
  }
}

let mainError: unknown;
try {
  await main();
} catch (error) {
  mainError = error;
}

let cleanupError: unknown;
try {
  await cleanup();
} catch (error) {
  cleanupError = error;
}

if (mainError) {
  if (cleanupError) {
    console.error('[acp-multi-harness] cleanup failed after smoke failure', cleanupError);
  }
  throw mainError;
}
if (cleanupError) throw cleanupError;
