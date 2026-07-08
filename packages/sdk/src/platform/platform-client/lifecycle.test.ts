import { test, expect, beforeEach, mock } from 'bun:test';
import { configureKortix } from '../config';
import type { KortixProject, ProjectSession, ProjectSessionSandbox, SessionStartResult } from '../projects-client';
import {
  getProviders,
  ensureSandbox,
  createSandbox,
  getSandbox,
  getSandboxById,
  renameSandbox,
  listSandboxes,
  discoverLocalSandbox,
  restartSandbox,
  stopSandbox,
  cancelSandbox,
  reactivateSandbox,
} from './lifecycle';

// This module composes `../projects-client` functions on top of `backendApi`,
// which ultimately goes through `globalThis.fetch` — so we mock fetch directly
// (branching on URL + method) the same way `../projects-client/*.test.ts`
// files do, rather than `mock.module`-ing `../projects-client` or `./shared`.
// `mock.module` registrations are process-wide/permanent for the whole `bun
// test` sweep, and this codebase has already hit (and fixed) a real collision
// hazard from doing that across files (see `state/server-store/active`) — real
// fetch-mocking avoids repeating it here.

let calls: { url: string; method: string; body: unknown }[] = [];
let handler: (url: string, method: string, body: unknown) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});

beforeEach(() => {
  delete process.env.BACKEND_URL;
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });
  calls = [];
  handler = () => ({ status: 200, body: {} });
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    const method = opts.method ?? 'GET';
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    calls.push({ url: String(url), method, body });
    const result = handler(String(url), method, body);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const callsMatching = (re: RegExp) => calls.filter((c) => re.test(c.url));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const project1: KortixProject = {
  project_id: 'proj-1',
  account_id: 'acc-1',
  name: 'Project One',
  repo_url: 'https://github.com/acme/one',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active',
  metadata: {},
  last_opened_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const project2: KortixProject = {
  ...project1,
  project_id: 'proj-2',
  name: 'Project Two',
};

// An already-running session with a sandbox — the "existing" fixture for ensureSandbox/getSandbox/etc.
const existingSession: ProjectSession = {
  session_id: 'sess-1',
  account_id: 'acc-1',
  project_id: 'proj-1',
  branch_name: 'sess-1',
  base_ref: 'main',
  sandbox_provider: 'daytona',
  sandbox_id: 'sbx-1',
  sandbox_url: 'http://backend.local/v1/p/ext-1/8000',
  opencode_session_id: 'oc-1',
  name: 'Session One',
  custom_name: null,
  agent_name: 'daytona',
  status: 'running',
  error: null,
  metadata: {},
  opencode_sessions: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const secondProjectSession: ProjectSession = {
  ...existingSession,
  session_id: 'sess-3',
  project_id: 'proj-2',
  sandbox_id: 'sbx-3',
  sandbox_url: 'http://backend.local/v1/p/ext-3/8000',
  branch_name: 'sess-3',
};

const newSession: ProjectSession = {
  session_id: 'sess-2',
  account_id: 'acc-1',
  project_id: 'proj-1',
  branch_name: 'sess-2',
  base_ref: 'main',
  sandbox_provider: null,
  sandbox_id: 'sess-2',
  sandbox_url: null,
  opencode_session_id: null,
  name: null,
  custom_name: null,
  agent_name: 'daytona',
  status: 'queued',
  error: null,
  metadata: {},
  opencode_sessions: [],
  created_at: '2026-01-03T00:00:00Z',
  updated_at: '2026-01-03T00:00:00Z',
};

const runtimeSandbox: ProjectSessionSandbox = {
  sandbox_id: 'sbx-2',
  session_id: 'sess-2',
  project_id: 'proj-1',
  account_id: 'acc-1',
  provider: 'daytona',
  external_id: 'ext-2',
  base_url: 'http://backend.local/v1/p/ext-2/8000',
  status: 'active',
  config: {},
  metadata: {},
  last_used_at: null,
  created_at: '2026-01-03T00:00:01Z',
  updated_at: '2026-01-03T00:00:01Z',
};

const startResult: SessionStartResult = {
  stage: 'ready',
  agent_name: 'daytona',
  retriable: false,
  sandbox: runtimeSandbox,
  opencode_session_id: 'oc-2',
  runtime_url: null,
};

/** GET /projects -> [project1]; GET /projects/proj-1/sessions -> [existingSession]. Nothing else wired. */
function wireExistingSandbox() {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [project1] };
    if (method === 'GET' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: [existingSession] };
    throw new Error(`unmocked ${method} ${url}`);
  };
}

/** GET /projects -> [project1]; sessions empty; POST create -> newSession; POST start -> startResult. */
function wireCreateFlow() {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [project1] };
    if (method === 'GET' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: [] };
    if (method === 'POST' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: newSession };
    if (method === 'POST' && /\/projects\/proj-1\/sessions\/sess-2\/start/.test(url)) {
      return { status: 200, body: startResult };
    }
    throw new Error(`unmocked ${method} ${url}`);
  };
}

/** GET /projects -> [] — no projects at all. */
function wireNoProjects() {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [] };
    throw new Error(`unmocked ${method} ${url}`);
  };
}

// ─── getProviders ────────────────────────────────────────────────────────────

test('getProviders is pure — no network, always daytona', async () => {
  const result = await getProviders();
  expect(result).toEqual({ providers: ['daytona'], default: 'daytona' });
  expect(calls.length).toBe(0);
});

// ─── ensureSandbox ───────────────────────────────────────────────────────────

test('ensureSandbox returns an existing sandbox untouched when one is found', async () => {
  wireExistingSandbox();

  const result = await ensureSandbox();

  expect(result.created).toBe(false);
  expect(result.sandbox.sandbox_id).toBe('sbx-1');
  expect(result.sandbox.external_id).toBe('ext-1');
  // Must not have created or started anything.
  expect(callsMatching(/\/sessions$/).filter((c) => c.method === 'POST').length).toBe(0);
  expect(callsMatching(/\/start/).length).toBe(0);
});

test('ensureSandbox creates + starts a session when a project exists but has no sandbox', async () => {
  wireCreateFlow();

  const result = await ensureSandbox();

  expect(result.created).toBe(true);
  expect(result.sandbox.sandbox_id).toBe('sbx-2');
  expect(result.sandbox.external_id).toBe('ext-2');
  expect(callsMatching(/\/projects\/proj-1\/sessions$/).some((c) => c.method === 'POST')).toBe(true);
  expect(callsMatching(/\/projects\/proj-1\/sessions\/sess-2\/start/).length).toBe(1);
});

test('ensureSandbox throws when there are no projects at all', async () => {
  wireNoProjects();
  await expect(ensureSandbox()).rejects.toThrow('Create a project before starting a sandbox');
});

// ─── createSandbox ───────────────────────────────────────────────────────────

test('createSandbox is a thin wrapper over ensureSandbox — returns only { sandbox }', async () => {
  wireCreateFlow();

  const result = await createSandbox();

  expect(Object.keys(result)).toEqual(['sandbox']);
  expect(result.sandbox.sandbox_id).toBe('sbx-2');
  expect(result.sandbox.external_id).toBe('ext-2');
});

// ─── getSandbox ──────────────────────────────────────────────────────────────

test('getSandbox returns the row sandbox when one exists', async () => {
  wireExistingSandbox();
  const result = await getSandbox();
  expect(result?.sandbox_id).toBe('sbx-1');
});

test('getSandbox resolves to null (not a rejection) when the lookup fails', async () => {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 500, body: { message: 'boom' } };
    throw new Error(`unmocked ${method} ${url}`);
  };
  const result = await getSandbox();
  expect(result).toBeNull();
});

// ─── getSandboxById ──────────────────────────────────────────────────────────

test('getSandboxById returns null immediately (no network) for undefined/empty/non-matching input', async () => {
  expect(await getSandboxById(undefined)).toBeNull();
  expect(await getSandboxById('')).toBeNull();
  expect(await getSandboxById({})).toBeNull();
  expect(calls.length).toBe(0);
});

test('getSandboxById resolves through findProjectSessionSandbox for a real id', async () => {
  wireExistingSandbox();
  const result = await getSandboxById('sbx-1');
  expect(result?.sandbox_id).toBe('sbx-1');
  expect(result?.external_id).toBe('ext-1');
});

// ─── renameSandbox ───────────────────────────────────────────────────────────

test('renameSandbox throws "not exposed" when the sandbox exists', async () => {
  wireExistingSandbox();
  await expect(renameSandbox('sbx-1', 'new name')).rejects.toThrow(
    'Renaming project-session sandboxes is not exposed by the current API',
  );
});

test('renameSandbox throws "not found" when the sandbox does not resolve', async () => {
  wireExistingSandbox();
  await expect(renameSandbox('no-such-sandbox', 'new name')).rejects.toThrow('Project session sandbox not found');
});

// ─── listSandboxes ───────────────────────────────────────────────────────────

function wireTwoProjectsTwoSessions() {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [project1, project2] };
    if (method === 'GET' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: [existingSession] };
    if (method === 'GET' && /\/projects\/proj-2\/sessions$/.test(url)) return { status: 200, body: [secondProjectSession] };
    throw new Error(`unmocked ${method} ${url}`);
  };
}

test('listSandboxes lists every session-backed sandbox across every project when no filter is given', async () => {
  wireTwoProjectsTwoSessions();
  const result = await listSandboxes();
  expect(result.map((s) => s.sandbox_id).sort()).toEqual(['sbx-1', 'sbx-3']);
});

test('listSandboxes filters by sandbox_id or external_id', async () => {
  wireTwoProjectsTwoSessions();
  expect((await listSandboxes('sbx-1')).map((s) => s.sandbox_id)).toEqual(['sbx-1']);
  expect((await listSandboxes('ext-3')).map((s) => s.sandbox_id)).toEqual(['sbx-3']);
});

test('listSandboxes degrades to [] when listProjectSessionSandboxes rejects', async () => {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 500, body: { message: 'boom' } };
    throw new Error(`unmocked ${method} ${url}`);
  };
  expect(await listSandboxes()).toEqual([]);
});

// ─── discoverLocalSandbox ────────────────────────────────────────────────────

test('discoverLocalSandbox short-circuits to null with no network call in this (non-DOM) test environment', async () => {
  expect(typeof window).toBe('undefined');
  const result = await discoverLocalSandbox();
  expect(result).toBeNull();
  expect(calls.length).toBe(0);
});

// ─── restartSandbox / stopSandbox ────────────────────────────────────────────

test('restartSandbox throws when no sandboxId is given', async () => {
  await expect(restartSandbox()).rejects.toThrow('No sandbox selected for workload restart');
  expect(calls.length).toBe(0);
});

test('restartSandbox throws "not found" when the id does not resolve to a row', async () => {
  wireExistingSandbox();
  await expect(restartSandbox('no-such-sandbox')).rejects.toThrow('Project session sandbox not found');
});

test('restartSandbox POSTs to the restart endpoint for the resolved project/session', async () => {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [project1] };
    if (method === 'GET' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: [existingSession] };
    if (method === 'POST' && /\/projects\/proj-1\/sessions\/sess-1\/restart$/.test(url)) {
      return { status: 200, body: { ok: true, session_id: 'sess-1', status: 'provisioning' } };
    }
    throw new Error(`unmocked ${method} ${url}`);
  };

  await restartSandbox('sbx-1');

  const restartCall = calls.find((c) => /\/restart$/.test(c.url));
  expect(restartCall?.method).toBe('POST');
  expect(restartCall?.url).toContain('/projects/proj-1/sessions/sess-1/restart');
});

test('stopSandbox throws when no sandboxId is given', async () => {
  await expect(stopSandbox()).rejects.toThrow('No sandbox selected to stop');
  expect(calls.length).toBe(0);
});

test('stopSandbox throws "not found" when the id does not resolve to a row', async () => {
  wireExistingSandbox();
  await expect(stopSandbox('no-such-sandbox')).rejects.toThrow('Project session sandbox not found');
});

test('stopSandbox POSTs to the stop endpoint for the resolved project/session', async () => {
  handler = (url, method) => {
    if (method === 'GET' && /\/projects$/.test(url)) return { status: 200, body: [project1] };
    if (method === 'GET' && /\/projects\/proj-1\/sessions$/.test(url)) return { status: 200, body: [existingSession] };
    if (method === 'POST' && /\/projects\/proj-1\/sessions\/sess-1\/stop$/.test(url)) {
      return { status: 200, body: { ok: true, session_id: 'sess-1', status: 'stopped' } };
    }
    throw new Error(`unmocked ${method} ${url}`);
  };

  await stopSandbox('sbx-1');

  const stopCall = calls.find((c) => /\/stop$/.test(c.url));
  expect(stopCall?.method).toBe('POST');
  expect(stopCall?.url).toContain('/projects/proj-1/sessions/sess-1/stop');
});

// ─── cancelSandbox / reactivateSandbox ───────────────────────────────────────

test('cancelSandbox always throws — cancellation is not exposed, regardless of args', async () => {
  await expect(cancelSandbox()).rejects.toThrow('Cancellation is not exposed for project-session sandboxes');
  await expect(cancelSandbox('sbx-1')).rejects.toThrow('Cancellation is not exposed for project-session sandboxes');
  expect(calls.length).toBe(0);
});

test('reactivateSandbox always throws — reactivation is not exposed, regardless of args', async () => {
  await expect(reactivateSandbox()).rejects.toThrow('Reactivation is not exposed for project-session sandboxes');
  await expect(reactivateSandbox('sbx-1')).rejects.toThrow(
    'Reactivation is not exposed for project-session sandboxes',
  );
  expect(calls.length).toBe(0);
});
