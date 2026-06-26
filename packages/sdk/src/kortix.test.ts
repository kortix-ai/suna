import { test, expect, beforeEach, mock } from 'bun:test';
import { createKortix } from './kortix';
import { isConfigured } from './platform/config';

// Capture every outbound request the facade makes.
let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, secrets: [], candidates: [], sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('createKortix wires the platform seam', () => {
  expect(isConfigured()).toBe(true);
});

test('facade exposes the core namespaces', () => {
  expect(typeof kortix.projects.list).toBe('function');
  expect(typeof kortix.accounts.list).toBe('function');
  expect(typeof kortix.project).toBe('function');
  expect(typeof kortix.session).toBe('function');
  expect(typeof kortix.runtime).toBe('function');
});

test('project(id) handle binds the id and hits the right endpoint', async () => {
  await kortix.project('PID123').secrets.list();
  expect(last().url).toContain('/projects/PID123/secrets');
  expect(last().method).toBe('GET');
});

test('session(projectId, sessionId) binds both ids', async () => {
  await kortix.session('PID123', 'SID456').previews();
  expect(last().url).toContain('/projects/PID123/sessions/SID456/previews');
});

test('project(id).session(sid) is the same session handle', async () => {
  await kortix.project('PA').session('SB').get();
  expect(last().url).toContain('/projects/PA/sessions/SB');
});

test('top-level projects.list hits /projects', async () => {
  await kortix.projects.list();
  expect(last().url).toContain('/projects');
});
