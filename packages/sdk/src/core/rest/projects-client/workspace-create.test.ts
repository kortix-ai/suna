/**
 * `createWorkspace`: one call creates a whole workspace with
 * `POST /v1/workspaces` (always a new account) and answers the `Workspace`.
 * An older API answers that route with a 404/405, or with the GitHub-import
 * 400 of `POST /v1/projects` (its alias before the workspace resource): the
 * call then sends `new_workspace: true` to `POST /v1/projects/provision`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { resetWorkspaceRouteMemory } from '../../http/workspace-routes';
import { createWorkspace, type CreateWorkspaceInput } from './workspaces';

type Call = { url: string; method: string; body: Record<string, unknown>; accept: string | null };

function recordingFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const call = {
      url,
      method: (input instanceof Request ? input.method : init?.method) ?? 'GET',
      body: JSON.parse(raw || '{}'),
      accept: headers.get('accept'),
    };
    calls.push(call);
    return answer(call);
  });
  return { calls, fetchImpl };
}

const served = {
  project_id: 'p1',
  workspace_id: 'p1',
  account_id: 'a1',
  name: 'Acme',
  role: 'owner',
  state: 'active',
  split_pending: false,
  deletion_scheduled_for: null,
  workspace: { workspace_id: 'p1', account_id: 'a1', account_role: 'owner', member_count: 1, mfa_required: false },
};
const legacyProject = { project_id: 'p1', account_id: 'a1', name: 'Acme' };

function configure(fetchImpl: unknown) {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok', fetch: fetchImpl as typeof fetch });
}

beforeEach(() => resetWorkspaceRouteMemory());

describe('createWorkspace', () => {
  test('without onEvent it POSTs /workspaces and answers the Workspace', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(served, { status: 201 }));
    configure(fetchImpl);

    const created = await createWorkspace({ name: 'Acme', idempotency_key: 'k-1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://backend.test/v1/workspaces' });
    expect(calls[0]!.body).toMatchObject({ name: 'Acme', idempotency_key: 'k-1', seed_starter: true });
    expect(calls[0]!.body).not.toHaveProperty('account_id');
    expect(calls[0]!.body).not.toHaveProperty('new_workspace');
    expect(created.workspace_id).toBe('p1');
    expect(created.role).toBe('owner');
    expect(created.state).toBe('active');
    expect(created.member_count).toBe(1);
    expect((created as unknown as Record<string, unknown>).workspace).toBeUndefined();
  });

  test('an account_id smuggled past the type is dropped, never sent', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(served, { status: 201 }));
    configure(fetchImpl);

    await createWorkspace({ name: 'Acme', account_id: 'other' } as unknown as CreateWorkspaceInput);

    expect(calls[0]!.body).not.toHaveProperty('account_id');
  });

  test.each([
    ['404 (an API older than the workspace mount)', 404, { error: true, message: 'Not found', status: 404 }],
    ['405', 405, { error: 'Method not allowed' }],
    ['the GitHub-import 400 of the old alias', 400, { error: 'repo_url is required' }],
  ])('an older API (%s): falls back to /projects/provision with new_workspace', async (_label, status, body) => {
    const { calls, fetchImpl } = recordingFetch((call) =>
      call.url.endsWith('/v1/projects/provision')
        ? Response.json(legacyProject, { status: 201 })
        : Response.json(body, { status }),
    );
    configure(fetchImpl);

    const created = await createWorkspace({ name: 'Acme' });

    const last = calls.at(-1)!;
    expect(last.url).toBe('http://backend.test/v1/projects/provision');
    expect(last.body).toMatchObject({ name: 'Acme', new_workspace: true });
    expect(created.workspace_id).toBe('p1');
    expect(created.role).toBe('owner');
    expect(created.state).toBe('active');
  });

  test('a real refusal rejects with the typed ApiError and does not fall back', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ error: 'restricted', code: 'account_creation_restricted' }, { status: 403 }),
    );
    configure(fetchImpl);

    const error = await createWorkspace({ name: 'Acme' }).catch((e) => e);

    expect(error).toMatchObject({ status: 403, code: 'account_creation_restricted' });
    expect(calls).toHaveLength(1);
  });

  test('with onEvent it streams POST /workspaces (Accept: text/event-stream) and answers the done frame workspace', async () => {
    const { calls, fetchImpl } = recordingFetch(
      () =>
        new Response(
          [
            'data: {"type":"phase","phase":"validating"}\n\n',
            'data: {"type":"phase","phase":"creating_repository"}\n\n',
            'data: {"type":"phase","phase":"registering"}\n\n',
            'data: {"type":"phase","phase":"seeding"}\n\n',
            `data: ${JSON.stringify({ type: 'done', project: legacyProject, workspace: served })}\n\n`,
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    configure(fetchImpl);
    const phases: string[] = [];

    const created = await createWorkspace(
      { name: 'Acme' },
      (event) => {
        if (event.type === 'phase') phases.push(event.phase);
      },
      { fetch: fetchImpl },
    );

    expect(phases).toEqual(['validating', 'creating_repository', 'registering', 'seeding']);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://backend.test/v1/workspaces', accept: 'text/event-stream' });
    expect(calls[0]!.body).not.toHaveProperty('new_workspace');
    expect(created.workspace_id).toBe('p1');
    expect(created.role).toBe('owner');
    expect(created.member_count).toBe(1);
  });

  test('with onEvent on an older API: falls back to /projects/provision-stream with new_workspace', async () => {
    const { calls, fetchImpl } = recordingFetch((call) =>
      call.url.endsWith('/v1/projects/provision-stream')
        ? new Response(`data: ${JSON.stringify({ type: 'done', project: legacyProject })}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : Response.json({ error: 'repo_url is required' }, { status: 400 }),
    );
    configure(fetchImpl);

    const created = await createWorkspace({ name: 'Acme' }, () => {}, { fetch: fetchImpl });

    expect(calls.at(-1)!.url).toBe('http://backend.test/v1/projects/provision-stream');
    expect(calls.at(-1)!.body).toMatchObject({ new_workspace: true });
    expect(created.workspace_id).toBe('p1');
    expect(created.role).toBe('owner');
  });

  test('a refused streamed creation rejects with the typed ApiError', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ error: 'restricted', code: 'account_creation_restricted' }, { status: 403 }),
    );
    configure(fetchImpl);

    const error = await createWorkspace({ name: 'Acme' }, () => {}, { fetch: fetchImpl }).catch((e) => e);

    expect(error).toMatchObject({ status: 403, code: 'account_creation_restricted' });
  });
});
