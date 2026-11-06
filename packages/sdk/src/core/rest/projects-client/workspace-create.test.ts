/**
 * `createWorkspace`: one call creates a whole workspace — the server picks or
 * creates its account and provisions its project (`new_workspace: true` on
 * POST /projects/provision and /projects/provision-stream). The caller names
 * no account.
 */
import { describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { createWorkspace, type CreateWorkspaceInput } from './projects';

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    calls.push({ url, body: JSON.parse(raw || '{}') });
    return response();
  });
  return { calls, fetchImpl };
}

const project = { project_id: 'p1', account_id: 'a1', name: 'Acme' };

describe('createWorkspace', () => {
  test('without onEvent it POSTs /projects/provision with new_workspace and no account_id', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(project, { status: 201 }));
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok', fetch: fetchImpl as unknown as typeof fetch });

    const created = await createWorkspace({ name: 'Acme', idempotency_key: 'k-1' });

    expect(created.project_id).toBe('p1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://backend.test/v1/workspaces/provision');
    expect(calls[0]!.body).toMatchObject({ name: 'Acme', new_workspace: true, seed_starter: true, idempotency_key: 'k-1' });
    expect(calls[0]!.body).not.toHaveProperty('account_id');
  });

  test('an account_id smuggled past the type is dropped, never sent', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(project, { status: 201 }));
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok', fetch: fetchImpl as unknown as typeof fetch });

    await createWorkspace({ name: 'Acme', account_id: 'other' } as unknown as CreateWorkspaceInput);

    expect(calls[0]!.body).not.toHaveProperty('account_id');
    expect(calls[0]!.body.new_workspace).toBe(true);
  });

  test('with onEvent it streams /projects/provision-stream and reports every phase', async () => {
    const { calls, fetchImpl } = recordingFetch(
      () =>
        new Response(
          [
            'data: {"type":"phase","phase":"validating"}\n\n',
            'data: {"type":"phase","phase":"creating_repository"}\n\n',
            'data: {"type":"phase","phase":"registering"}\n\n',
            'data: {"type":"phase","phase":"seeding"}\n\n',
            `data: ${JSON.stringify({ type: 'done', project })}\n\n`,
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    const phases: string[] = [];

    const created = await createWorkspace(
      { name: 'Acme' },
      (event) => {
        if (event.type === 'phase') phases.push(event.phase);
      },
      { fetch: fetchImpl },
    );

    expect(created.project_id).toBe('p1');
    expect(phases).toEqual(['validating', 'creating_repository', 'registering', 'seeding']);
    expect(calls[0]!.url).toBe('http://backend.test/v1/workspaces/provision-stream');
    expect(calls[0]!.body).toMatchObject({ name: 'Acme', new_workspace: true });
    expect(calls[0]!.body).not.toHaveProperty('account_id');
  });

  test('a refused creation rejects with the typed ApiError', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json(
        { error: 'Creating new workspaces is restricted', code: 'account_creation_restricted' },
        { status: 403 },
      ),
    );
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

    const error = await createWorkspace({ name: 'Acme' }, () => {}, { fetch: fetchImpl }).catch((e) => e);

    expect(error).toMatchObject({ status: 403, code: 'account_creation_restricted' });
  });
});
