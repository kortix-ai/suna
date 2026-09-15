import { beforeEach, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const pid = '33333333-3333-4333-8333-333333333333';
const sid = '55555555-5555-4555-8555-555555555555';
const sha = 'a'.repeat(40);
let caller: string | null = sid;
let session: any;
let identity: any;
let calls: any[] = [];
let fail = false;
const files = [
  {
    placement: 'environment',
    source: 'helper.py',
    target: '/opt/kortix/helpers/check.py',
    mode: 'read_only',
  },
];
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (session ? [session] : []) }) }),
    }),
  },
}));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: 'user',
    row: { projectId: pid, accountId: 'account', defaultBranch: 'main' },
  }),
  assertProjectCapability: async () => {},
}));
mock.module('../lib/caller-session', () => ({ callerKortixSessionId: () => caller }));
mock.module('../lib/serializers', () => ({ UUID_V4_REGEX: /^[a-f0-9-]{36}$/ }));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: {
    PROJECT_SESSION_READ: 'project.session.read',
    PROJECT_SESSION_START: 'project.session.start',
    PROJECT_SESSION_STOP: 'project.session.stop',
  },
}));
mock.module('../lib/git', () => ({ withProjectGitAuth: async (row: unknown) => row }));
mock.module('../lib/ensure-pi-worker-identity', () => ({
  ensurePiWorkerIdentity: async () => identity,
}));
mock.module('../../git-proxy/compiled-pi-runtime-artifact', () => ({
  listPiAgentNames: async () => [],
  resolvePiDefaultAgentName: async () => null,
  normalizePiAgentName: (name: string) => name,
  CompiledPiRuntimeSourceMovedError: class extends Error {},
  buildCompiledPiRuntimeArtifact: async (...args: any[]) => {
    calls.push(args);
    if (fail) throw new Error('compile failed');
    return {
      manifest: {
        agent_resources: [
          { placement: 'worker', name: 'private', source: 'private.json' },
          ...files,
        ],
      },
    };
  },
}));
mock.module('../../platform/services/session-environment', () => ({
  ensureSessionEnvironment: async () => {
    throw new Error('must not start compute');
  },
  readSessionEnvironment: async () => null,
  stopSessionEnvironment: async () => null,
  SessionEnvironmentError: class extends Error {},
  SessionEnvironmentStopError: class extends Error {},
}));

const { projectsApp } = await import('../lib/app');
await import('./session-environment');
const app = new Hono().route('/v1/projects', projectsApp);
const request = () => app.request(`/v1/projects/${pid}/sessions/${sid}/environment/resources`);
beforeEach(() => {
  caller = sid;
  session = {
    agentName: 'reader',
    baseRef: 'moving-branch',
    metadata: { sandbox_slug: 'pi-worker' },
  };
  identity = { ref: 'pinned-ref', sha };
  calls = [];
  fail = false;
});

test('environment resources use the session release and agent, never start compute, and omit worker resources', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    project_id: pid,
    session_id: sid,
    agent_name: 'reader',
    source_sha: sha,
    files,
  });
  expect(calls[0].slice(1)).toEqual([sha, sha, 'reader']);
});

test.each([
  [
    'another session',
    403,
    () => {
      caller = 'other';
    },
  ],
  [
    'missing session',
    404,
    () => {
      session = null;
    },
  ],
  [
    'deleted session',
    404,
    () => {
      session.metadata.deletedAt = new Date().toISOString();
    },
  ],
  [
    'OpenCode session',
    400,
    () => {
      session.metadata.sandbox_slug = 'default';
    },
  ],
  [
    'missing release',
    409,
    () => {
      identity = null;
    },
  ],
] as const)('environment resources reject %s before compilation', async (_, status, setup) => {
  setup();
  expect((await request()).status).toBe(status);
  expect(calls).toHaveLength(0);
});

test('compilation errors fail closed and an owner can read the same pinned files', async () => {
  fail = true;
  expect((await request()).status).toBe(503);
  fail = false;
  caller = null;
  expect((await request()).status).toBe(200);
});
