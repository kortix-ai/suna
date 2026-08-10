#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';

import { createScopedKortix } from '@kortix/sdk/server';

import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  signIn,
  type AuthSession,
  type AuthUser,
} from '../helpers/session-auth';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'SessionRewind123!';
const api = createApiJsonClient(apiBase);
const keepFixture = process.env.E2E_KEEP_SESSION_REWIND_FIXTURE === '1';
const model = 'kortix/claude-sonnet-4.6';

let user: AuthUser | null = null;
let auth: AuthSession | null = null;
let workspaceId = '';
let sessionId = '';

function log(label: string, detail: string): void {
  console.log(`[session-rewind] ${label}: ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  if (!accept(value)) throw new Error(`${label} timed out`);
  return value;
}

async function waitForReady(token: string): Promise<{
  runtime_transport: 'rest';
  opencode_session_id: string;
  sandbox: { external_id: string; sandbox_id: string; status: string };
}> {
  return waitFor(
    () =>
      api<any>(
        token,
        'POST',
        `/projects/${workspaceId}/sessions/${sessionId}/start?wait_ms=8000`,
        {},
      ),
    (value) =>
      value.stage === 'ready' &&
      value.runtime_transport === 'rest' &&
      value.sandbox?.status === 'active' &&
      Boolean(value.sandbox?.external_id) &&
      Boolean(value.opencode_session_id),
    'REST session readiness',
    12 * 60_000,
  );
}

function authorizedFetch(token: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

function messageText(message: {
  parts: Array<{ type: string; text?: string }>;
}): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

async function main(): Promise<void> {
  const email = `session-rewind-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  user = await createAuthUser(email, { supabaseUrl, password });
  auth = await signIn(email, { supabaseUrl, password });
  const token = auth.access_token;

  const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
    token,
    'GET',
    '/accounts',
  );
  const account = accounts.find((item) => item.personal_account) ?? accounts[0];
  assert(account?.account_id, 'No account was created for the rewind fixture');

  const project = await api<{ project_id: string }>(
    token,
    'POST',
    '/projects/provision',
    {
      account_id: account.account_id,
      name: `Session rewind ${Date.now()}`,
      seed_starter: true,
    },
    201,
  );
  workspaceId = project.project_id;
  await api(token, 'PATCH', `/projects/${workspaceId}/onboarding`, { completed: true });
  await api(token, 'PUT', `/projects/${workspaceId}/model-defaults`, {
    scope: 'project',
    model: 'claude-sonnet-4.6',
  });
  const agentConfig = await api<{
    block: Record<string, any>;
  }>(token, 'GET', `/projects/${workspaceId}/agents/kortix/config`);
  await api(token, 'PUT', `/projects/${workspaceId}/agents/kortix/config`, {
    ...agentConfig.block,
    opencode: {
      ...agentConfig.block.opencode,
      permission: {
        read: 'allow',
        edit: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        bash: 'allow',
        task: 'allow',
        external_directory: 'allow',
        lsp: 'allow',
        todowrite: 'allow',
        question: 'allow',
        webfetch: 'allow',
        websearch: 'allow',
        doom_loop: 'allow',
        skill: 'allow',
      },
    },
  });
  const session = await api<{ session_id: string }>(
    token,
    'POST',
    `/projects/${workspaceId}/sessions`,
    {
      name: 'Session rewind smoke',
      opencode_model: model,
    },
    201,
  );
  sessionId = session.session_id;

  const restReady = await waitForReady(token);
  const canonicalSessionId = restReady.opencode_session_id;
  const runtimeUrl = `${apiBase}/p/${restReady.sandbox.external_id}/8000`;

  const kortix = createScopedKortix({
    backendUrl: apiBase,
    getToken: () => token,
  });
  const handle = kortix.session(workspaceId, sessionId);
  const readFile = async (path: string) => (await handle.files.read(path)).content.trim();
  const waitForFile = (path: string, expected: string) =>
    waitFor(
      () => readFile(path).catch(() => ''),
      (value) => value === expected,
      `${path}=${expected}`,
    );

  handle.setModel({ providerID: 'kortix', modelID: 'claude-sonnet-4.6' });

  const restOne = 'REST_REWIND_ONE';
  const restTwo = 'REST_REWIND_TWO';
  const restThree = 'REST_REWIND_REPLACEMENT';
  const restPath = '/workspace/rest-rewind-proof.txt';
  await handle.send(
    `Use bash to write exactly ${restOne} to ${restPath}. Then reply exactly REST_ONE_DONE.`,
  );
  await waitForFile(restPath, restOne);
  await handle.send(
    `Use bash to overwrite ${restPath} with exactly ${restTwo}. Then reply exactly REST_TWO_DONE.`,
  );
  await waitForFile(restPath, restTwo);

  const readRuntimeMessages = async () => {
    const response = await authorizedFetch(token)(
      `${runtimeUrl}/session/${encodeURIComponent(canonicalSessionId)}/message?directory=${encodeURIComponent('/workspace')}`,
    );
    if (!response.ok) {
      throw new Error(`REST message read failed with HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as Array<{
      info: { id: string; sessionID: string; role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;
  };
  const restMessages = await readRuntimeMessages();
  const restSecond = [...restMessages]
    .reverse()
    .find(
      (message) =>
        message.info.role === 'user' && messageText(message).includes('REST_TWO_DONE'),
    );
  assert(restSecond, 'REST second user message was not persisted');

  await handle.rewind(restSecond.info.id);
  await waitForFile(restPath, restOne);
  await handle.restoreRewind();
  await waitForFile(restPath, restTwo);
  await handle.rewind(restSecond.info.id);
  await handle.send(
    `Use bash to overwrite ${restPath} with exactly ${restThree}. Then reply exactly REST_REPLACEMENT_DONE.`,
  );
  await waitForFile(restPath, restThree);
  const committedRestMessages = await waitFor(
    readRuntimeMessages,
    (messages) => {
      const text = messages.map(messageText).join('\n');
      return !text.includes('REST_TWO_DONE') && text.includes('REST_REPLACEMENT_DONE');
    },
    'REST replacement transcript cleanup',
  );
  assert(
    committedRestMessages.every((message) => message.info.sessionID === canonicalSessionId),
    'REST rewind changed the canonical session',
  );
  log(
    'REST',
    `same_session=${canonicalSessionId} rewind=${restSecond.info.id} restore=true replacement=true file=${restThree}`,
  );
}

async function cleanup(): Promise<void> {
  if (keepFixture) {
    log('fixture', `kept project=${workspaceId} session=${sessionId}`);
    return;
  }
  if (auth && workspaceId && sessionId) {
    await api(
      auth.access_token,
      'DELETE',
      `/projects/${workspaceId}/sessions/${sessionId}`,
    ).catch(() => {});
  }
  if (auth && workspaceId) {
    await api(auth.access_token, 'DELETE', `/projects/${workspaceId}`).catch(() => {});
  }
  if (user?.id) {
    await deleteAuthUser(user.id, {
      supabaseUrl,
      envFiles: ['apps/api/.env', 'apps/web/.env'],
    });
  }
}

try {
  await main();
  log('result', 'PASS');
} finally {
  await cleanup();
}
