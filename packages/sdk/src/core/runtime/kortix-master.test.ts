import { test, expect, beforeEach, mock, describe } from 'bun:test';
import type { Ticket, SandboxService, SandboxServiceTemplate } from './kortix-master';

// This file must be hermetic against process-wide `mock.module('../http/auth', ...)`
// registrations made by OTHER test files (files/client.test.ts, opencode/env.test.ts,
// opencode/triggers.test.ts, opencode/client.test.ts, session/session.test.ts all mock
// the same shared module path). Bun's `mock.module` is process-wide and permanent for
// the whole `bun test` sweep — whichever file's registration is resident when THIS
// file's own dynamic `import('./kortix-master')` below runs wins for every call made
// through that import. So this file registers its OWN mock for '../platform/auth' —
// with a controllable token + authenticatedFetch implementation this file fully owns —
// instead of depending on the real module's behavior, and imports the module under
// test via `await import(...)` so it resolves against ITS OWN mock regardless of load
// order (matching opencode/client.test.ts's pattern post-#4124).

interface Call {
  url: string;
  method: string;
  body?: string;
  retryOnAuthError?: boolean;
  hasSignal: boolean;
}

let calls: Call[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });

let authToken: string | null = 'test-token';
mock.module('../http/auth', () => ({
  getAuthToken: async () => authToken,
  getAuthTokenWithRetry: async () => authToken,
  authenticatedFetch: async (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: { retryOnAuthError?: boolean },
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      retryOnAuthError: options?.retryOnAuthError,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    return nextResponse();
  },
  invalidateTokenCache: () => {},
  setCachedAuthToken: () => {},
  setBootstrapAuthToken: () => {},
  getSupabaseAccessToken: async () => authToken,
  getSupabaseAccessTokenWithRetry: async () => authToken,
}));

const KM = await import('./kortix-master');
const last = () => calls[calls.length - 1];
const BASE = 'http://sbx.test';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  authToken = 'test-token';
  nextResponse = () => jsonResponse({});
});

// ─── request core ───────────────────────────────────────────────────────────

describe('request core (via listTickets)', () => {
  test('strips trailing slashes from the base url', async () => {
    await KM.listTickets('http://sbx.test///');
    expect(last().url).toBe('http://sbx.test/kortix/tickets');
  });

  test('returns the parsed JSON body on success', async () => {
    nextResponse = () => jsonResponse([{ id: 't-1' }]);
    const result = await KM.listTickets(BASE);
    expect(result).toEqual([{ id: 't-1' }] as unknown as Ticket[]);
  });

  test('throws the daemon error message on a non-2xx response', async () => {
    nextResponse = () => jsonResponse({ error: 'Ticket not found' }, 404);
    await expect(KM.getTicket(BASE, 't-1')).rejects.toThrow('Ticket not found');
  });

  test('falls back to a generic message when the error body has neither error nor message', async () => {
    nextResponse = () => new Response('', { status: 500 });
    await expect(KM.listTickets(BASE)).rejects.toThrow('Request failed with 500');
  });

  test('surfaces a details-only error body (services routes reply this shape)', async () => {
    nextResponse = () => jsonResponse({ details: 'npm install failed: ENOSPC' }, 500);
    await expect(KM.listServices(BASE)).rejects.toThrow('npm install failed: ENOSPC');
  });

  test('tolerates an empty/non-JSON success body instead of throwing a parse error', async () => {
    nextResponse = () => new Response('', { status: 200 });
    await expect(KM.deleteTicket(BASE, 't-1')).resolves.toEqual({} as unknown as { deleted: true });
  });
});

// ─── tasks ──────────────────────────────────────────────────────────────────

describe('tasks', () => {
  test('listTasks GETs /kortix/tasks with project_id + status query params', async () => {
    await KM.listTasks(BASE, { projectId: 'p-1', status: 'todo' });
    expect(last().url).toBe('http://sbx.test/kortix/tasks?project_id=p-1&status=todo');
    expect(last().method).toBe('GET');
  });

  test('listTasks omits the query string when no params are given', async () => {
    await KM.listTasks(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/tasks');
  });

  test('getTask GETs /kortix/tasks/:id', async () => {
    await KM.getTask(BASE, 't-1');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1');
  });

  test('listTaskEvents GETs /kortix/tasks/:id/events', async () => {
    await KM.listTaskEvents(BASE, 't-1');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1/events');
  });

  test('getTaskStatus GETs /kortix/tasks/:id/status', async () => {
    await KM.getTaskStatus(BASE, 't-1');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1/status');
  });

  test('createTask POSTs /kortix/tasks with the JSON body', async () => {
    await KM.createTask(BASE, { project_id: 'p-1', title: 'Do the thing' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/tasks');
    expect(JSON.parse(last().body!)).toEqual({ project_id: 'p-1', title: 'Do the thing' });
  });

  test('updateTask PATCHes /kortix/tasks/:id', async () => {
    await KM.updateTask(BASE, 't-1', { status: 'completed' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1');
    expect(JSON.parse(last().body!)).toEqual({ status: 'completed' });
  });

  test('startTask POSTs /kortix/tasks/:id/start', async () => {
    await KM.startTask(BASE, 't-1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1/start');
  });

  test('approveTask POSTs /kortix/tasks/:id/approve', async () => {
    await KM.approveTask(BASE, 't-1');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1/approve');
  });

  test('deleteTask DELETEs /kortix/tasks/:id', async () => {
    await KM.deleteTask(BASE, 't-1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t-1');
  });

  test('encodes ids that contain path-unsafe characters', async () => {
    await KM.getTask(BASE, 't/1 x');
    expect(last().url).toBe('http://sbx.test/kortix/tasks/t%2F1%20x');
  });
});

// ─── tickets ────────────────────────────────────────────────────────────────

describe('tickets', () => {
  test('listTickets GETs /kortix/tickets, scoped by project_id when given', async () => {
    await KM.listTickets(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/tickets?project_id=p-1');
  });

  test('listTickets omits the query string with no project id', async () => {
    await KM.listTickets(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/tickets');
  });

  test('getTicket GETs /kortix/tickets/:id', async () => {
    await KM.getTicket(BASE, 'tk-1');
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1');
  });

  test('listTicketEvents GETs /kortix/tickets/:id/events', async () => {
    await KM.listTicketEvents(BASE, 'tk-1');
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1/events');
  });

  test('createTicket POSTs /kortix/tickets with the full body incl. actor identity', async () => {
    await KM.createTicket(BASE, {
      project_id: 'p-1',
      title: 'Fix the bug',
      actor_type: 'user',
      actor_id: 'marko',
      created_by_type: 'user',
      created_by_id: 'marko',
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/tickets');
    expect(JSON.parse(last().body!)).toMatchObject({ title: 'Fix the bug', actor_id: 'marko' });
  });

  test('updateTicket PATCHes /kortix/tickets/:id', async () => {
    await KM.updateTicket(BASE, 'tk-1', { title: 'New title', actor_type: 'user', actor_id: 'marko' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1');
  });

  test('updateTicketStatus POSTs /kortix/tickets/:id/status', async () => {
    await KM.updateTicketStatus(BASE, 'tk-1', { status: 'done', actor_type: 'user', actor_id: 'marko' });
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1/status');
    expect(JSON.parse(last().body!)).toEqual({ status: 'done', actor_type: 'user', actor_id: 'marko' });
  });

  test('assignTicket POSTs /kortix/tickets/:id/assign', async () => {
    await KM.assignTicket(BASE, 'tk-1', {
      assignee_type: 'user',
      assignee_id: 'marko',
      actor_type: 'user',
      actor_id: 'marko',
    });
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1/assign');
  });

  test('unassignTicket POSTs /kortix/tickets/:id/unassign', async () => {
    await KM.unassignTicket(BASE, 'tk-1', {
      assignee_type: 'agent',
      assignee_id: 'pm',
      actor_type: 'user',
      actor_id: 'marko',
    });
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1/unassign');
  });

  test('commentTicket POSTs /kortix/tickets/:id/comments', async () => {
    await KM.commentTicket(BASE, 'tk-1', { body: 'looks good', actor_type: 'user', actor_id: 'marko' });
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1/comments');
  });

  test('deleteTicket DELETEs /kortix/tickets/:id', async () => {
    await KM.deleteTicket(BASE, 'tk-1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/tickets/tk-1');
  });
});

// ─── columns / fields / templates ───────────────────────────────────────────

describe('columns', () => {
  test('listColumns GETs /kortix/projects/:id/columns', async () => {
    await KM.listColumns(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/columns');
  });

  test('replaceColumns PUTs the columns array', async () => {
    await KM.replaceColumns(BASE, 'p-1', [{ key: 'todo', label: 'Todo' }]);
    expect(last().method).toBe('PUT');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/columns');
    expect(JSON.parse(last().body!)).toEqual({ columns: [{ key: 'todo', label: 'Todo' }] });
  });
});

describe('fields', () => {
  test('listFields GETs /kortix/projects/:id/fields', async () => {
    await KM.listFields(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/fields');
  });

  test('replaceFields PUTs the fields array', async () => {
    await KM.replaceFields(BASE, 'p-1', [{ key: 'priority', label: 'Priority', type: 'select' }]);
    expect(last().method).toBe('PUT');
    expect(JSON.parse(last().body!)).toEqual({ fields: [{ key: 'priority', label: 'Priority', type: 'select' }] });
  });
});

describe('templates', () => {
  test('listTemplates GETs /kortix/projects/:id/templates', async () => {
    await KM.listTemplates(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/templates');
  });

  test('replaceTemplates PUTs the templates array', async () => {
    await KM.replaceTemplates(BASE, 'p-1', [{ name: 'Bug report', body_md: '# Bug' }]);
    expect(last().method).toBe('PUT');
    expect(JSON.parse(last().body!)).toEqual({ templates: [{ name: 'Bug report', body_md: '# Bug' }] });
  });
});

// ─── pm session / agents / activity ─────────────────────────────────────────

test('ensurePmSession POSTs /kortix/projects/:id/pm-session', async () => {
  await KM.ensurePmSession(BASE, 'p-1');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/pm-session');
});

describe('project agents', () => {
  test('listProjectAgents GETs /kortix/projects/:id/agents', async () => {
    await KM.listProjectAgents(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/agents');
  });

  test('createProjectAgent POSTs /kortix/projects/:id/agents', async () => {
    await KM.createProjectAgent(BASE, 'p-1', { slug: 'pm', name: 'PM', body_md: '# PM' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/agents');
  });

  test('updateProjectAgent PATCHes /kortix/projects/:id/agents/:slug', async () => {
    await KM.updateProjectAgent(BASE, 'p-1', 'pm', { name: 'Project Manager' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/agents/pm');
  });

  test('deleteProjectAgent DELETEs /kortix/projects/:id/agents/:slug', async () => {
    await KM.deleteProjectAgent(BASE, 'p-1', 'pm');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/agents/pm');
  });

  test('getAgentPersona GETs /kortix/projects/:id/agents/:slug/persona', async () => {
    await KM.getAgentPersona(BASE, 'p-1', 'pm');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/agents/pm/persona');
  });
});

test('getProjectActivity GETs /kortix/projects/:id/activity with a limit', async () => {
  await KM.getProjectActivity(BASE, 'p-1');
  expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/activity?limit=200');

  await KM.getProjectActivity(BASE, 'p-1', 50);
  expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/activity?limit=50');
});

// ─── projects ───────────────────────────────────────────────────────────────

describe('projects', () => {
  test('listKortixProjects GETs /kortix/projects', async () => {
    await KM.listKortixProjects(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/projects');
  });

  test('getKortixProject GETs /kortix/projects/:id', async () => {
    await KM.getKortixProject(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1');
  });

  test('getKortixProjectBySession GETs /kortix/projects/by-session/:id', async () => {
    await KM.getKortixProjectBySession(BASE, 's-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/by-session/s-1');
  });

  test('listKortixProjectSessions GETs /kortix/projects/:id/sessions', async () => {
    await KM.listKortixProjectSessions(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/sessions');
  });

  test('deleteKortixProject DELETEs /kortix/projects/:id', async () => {
    await KM.deleteKortixProject(BASE, 'p-1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1');
  });

  test('patchKortixProject PATCHes /kortix/projects/:id', async () => {
    await KM.patchKortixProject(BASE, 'p-1', { name: 'Renamed' });
    expect(last().method).toBe('PATCH');
    expect(JSON.parse(last().body!)).toEqual({ name: 'Renamed' });
  });
});

// ─── milestones ─────────────────────────────────────────────────────────────

describe('milestones', () => {
  test('listMilestones GETs /kortix/projects/:id/milestones with a status filter, default "all"', async () => {
    await KM.listMilestones(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones?status=all');

    await KM.listMilestones(BASE, 'p-1', 'open');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones?status=open');
  });

  test('getMilestone GETs /kortix/projects/:id/milestones/:ref', async () => {
    await KM.getMilestone(BASE, 'p-1', 'm-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1');
  });

  test('listMilestoneEvents GETs /kortix/projects/:id/milestones/:ref/events', async () => {
    await KM.listMilestoneEvents(BASE, 'p-1', 'm-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1/events');
  });

  test('createMilestone POSTs /kortix/projects/:id/milestones', async () => {
    await KM.createMilestone(BASE, 'p-1', { title: 'v1' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones');
  });

  test('updateMilestone PATCHes /kortix/projects/:id/milestones/:ref', async () => {
    await KM.updateMilestone(BASE, 'p-1', 'm-1', { title: 'v1.1' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1');
  });

  test('closeMilestone POSTs /kortix/projects/:id/milestones/:ref/close', async () => {
    await KM.closeMilestone(BASE, 'p-1', 'm-1', { summary_md: 'done' });
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1/close');
  });

  test('reopenMilestone POSTs /kortix/projects/:id/milestones/:ref/reopen', async () => {
    await KM.reopenMilestone(BASE, 'p-1', 'm-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1/reopen');
  });

  test('deleteMilestone DELETEs /kortix/projects/:id/milestones/:ref', async () => {
    await KM.deleteMilestone(BASE, 'p-1', 'm-1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/milestones/m-1');
  });
});

// ─── credentials ────────────────────────────────────────────────────────────

describe('credentials', () => {
  test('listCredentials GETs /kortix/projects/:id/credentials', async () => {
    await KM.listCredentials(BASE, 'p-1');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/credentials');
  });

  test('listCredentialEvents GETs /kortix/projects/:id/credentials/:name/events', async () => {
    await KM.listCredentialEvents(BASE, 'p-1', 'STRIPE_KEY');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/credentials/STRIPE_KEY/events');
  });

  test('upsertCredential POSTs /kortix/projects/:id/credentials', async () => {
    await KM.upsertCredential(BASE, 'p-1', { name: 'STRIPE_KEY', value: 'sk_test' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/credentials');
  });

  test('revealCredential GETs /kortix/projects/:id/credentials/:name', async () => {
    await KM.revealCredential(BASE, 'p-1', 'STRIPE_KEY');
    expect(last().method).toBe('GET');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/credentials/STRIPE_KEY');
  });

  test('deleteCredential DELETEs /kortix/projects/:id/credentials/:name', async () => {
    await KM.deleteCredential(BASE, 'p-1', 'STRIPE_KEY');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/projects/p-1/credentials/STRIPE_KEY');
  });
});

// ─── services ───────────────────────────────────────────────────────────────

describe('services', () => {
  test('listServices GETs /kortix/services, unwraps the {services} envelope, and defaults to []', async () => {
    nextResponse = () => jsonResponse({ services: [{ id: 's-1' }] });
    const services = await KM.listServices(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/services');
    expect(services).toEqual([{ id: 's-1' }] as unknown as SandboxService[]);

    nextResponse = () => jsonResponse({});
    expect(await KM.listServices(BASE)).toEqual([]);
  });

  test('listServices(includeAll=true) adds ?all=true', async () => {
    await KM.listServices(BASE, true);
    expect(last().url).toBe('http://sbx.test/kortix/services?all=true');
  });

  test('listServiceTemplates GETs /kortix/services/templates and unwraps {templates}', async () => {
    nextResponse = () => jsonResponse({ templates: [{ id: 't-1' }] });
    const templates = await KM.listServiceTemplates(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/services/templates');
    expect(templates).toEqual([{ id: 't-1' }] as unknown as SandboxServiceTemplate[]);
  });

  test('getServiceLogs GETs /kortix/services/:id/logs and unwraps {logs}', async () => {
    nextResponse = () => jsonResponse({ logs: ['line 1'] });
    const logs = await KM.getServiceLogs(BASE, 'svc-1');
    expect(last().url).toBe('http://sbx.test/kortix/services/svc-1/logs');
    expect(logs).toEqual(['line 1']);
  });

  test('serviceAction POSTs /kortix/services/:id/:action for start/stop/restart', async () => {
    await KM.serviceAction(BASE, 'svc-1', 'start');
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/services/svc-1/start');

    await KM.serviceAction(BASE, 'svc-1', 'restart');
    expect(last().url).toBe('http://sbx.test/kortix/services/svc-1/restart');
  });

  test('serviceAction DELETEs /kortix/services/:id for the delete action', async () => {
    await KM.serviceAction(BASE, 'svc-1', 'delete');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('http://sbx.test/kortix/services/svc-1');
  });

  test('reconcileServices POSTs /kortix/services/reconcile, optionally with ?reload=true', async () => {
    await KM.reconcileServices(BASE);
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/services/reconcile');

    await KM.reconcileServices(BASE, true);
    expect(last().url).toBe('http://sbx.test/kortix/services/reconcile?reload=true');
  });

  test('registerService POSTs /kortix/services/register with the payload', async () => {
    await KM.registerService(BASE, { id: 'svc-2', name: 'worker' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe('http://sbx.test/kortix/services/register');
    expect(JSON.parse(last().body!)).toEqual({ id: 'svc-2', name: 'worker' });
  });

  test('every services call disables the shared 401-retry and sets a client-side timeout signal', async () => {
    await KM.listServices(BASE);
    expect(last().retryOnAuthError).toBe(false);
    expect(last().hasSignal).toBe(true);
  });

  test('non-services calls use the default (retrying) auth behavior and no timeout signal', async () => {
    await KM.listTickets(BASE);
    expect(last().retryOnAuthError).toBeUndefined();
    expect(last().hasSignal).toBe(false);
  });
});
