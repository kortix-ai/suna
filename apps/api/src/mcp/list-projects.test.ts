import { describe, expect, test } from 'bun:test';
import { runTool, type ToolResult } from './index';

// list_projects reaches the API through ctx.dispatch, the same in-process
// dispatch the real route table gets. A canned dispatch answers the two reads
// the tool makes (GET /v1/accounts, GET /v1/projects?account_id=…) with the
// JSON bodies an empty account and a populated one produce.
function api(bodies: Record<string, unknown>) {
  return async (req: Request) => {
    const body = bodies[new URL(req.url).pathname];
    return new Response(JSON.stringify(body ?? { error: 'unrouted' }), {
      status: body === undefined ? 500 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function ctx(dispatch: (req: Request) => Promise<Response>) {
  return {
    authorization: 'Bearer test',
    origin: 'http://localhost:8008',
    headers: new Headers(),
    dispatch,
    deadline: Date.now() + 5_000,
  };
}

/** The text a client JSON.parses: content[0].text must be JSON in every account state. */
function dataText(r: ToolResult): string {
  const first = r.content[0]!;
  if (first.type !== 'text') throw new Error(`expected a text part, got ${first.type}`);
  return first.text;
}

const account = { account_id: '11111111-1111-1111-1111-111111111111', name: 'Personal' };
const project = {
  project_id: '22222222-2222-2222-2222-222222222222',
  name: 'dogfood-test',
  effective_project_role: 'owner',
};

describe('list_projects', () => {
  test('an account with no projects answers a JSON array, not prose', async () => {
    const r = await runTool(ctx(api({ '/v1/accounts': [] })), 'list_projects', {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(dataText(r))).toEqual([]);
  });

  test('an account whose project list is empty answers a JSON array, not prose', async () => {
    const r = await runTool(ctx(api({ '/v1/accounts': [account], '/v1/projects': [] })), 'list_projects', {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(dataText(r))).toEqual([]);
  });

  test('the legacy {accounts: []} body shape answers a JSON array too', async () => {
    const r = await runTool(ctx(api({ '/v1/accounts': { accounts: [] } })), 'list_projects', {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(dataText(r))).toEqual([]);
  });

  test('a populated account keeps the array of project rows', async () => {
    const r = await runTool(
      ctx(api({ '/v1/accounts': [account], '/v1/projects': [project] })),
      'list_projects',
      {},
    );
    expect(JSON.parse(dataText(r))).toEqual([
      {
        project_id: '22222222-2222-2222-2222-222222222222',
        name: 'dogfood-test',
        account: 'Personal',
        account_id: '11111111-1111-1111-1111-111111111111',
        repository: null,
        default_branch: null,
        role: 'owner',
      },
    ]);
  });
});
