import { beforeEach, expect, mock, test } from 'bun:test';
import { connectorDataPlane } from '../../client/project-connectors';
import { configureKortix } from '../../http/config';
import {
  type ConnectorArgs,
  type ConnectorResult,
  describeConnectorTool,
  getConnectorCatalog,
} from './connectors';

// What `kortix connectors types` writes into a consumer's project, with a
// synthetic connector. The augmentation targets this module because the
// published `@kortix/sdk` re-exports it with `export *`.
declare module './connectors' {
  interface ConnectorActionRegistry {
    'ke2e-typed': {
      list_issues: {
        args: { team: string; limit?: number };
        result: { issues: Array<{ id: string }> };
      };
    };
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { issues: { type: 'array', items: { type: 'object' } } },
};

let urls: string[] = [];
let bodies: unknown[] = [];
let responseBody: unknown;

beforeEach(() => {
  urls = [];
  bodies = [];
  responseBody = {
    connectors: [
      {
        slug: 'ke2e-typed',
        name: 'Typed',
        provider: 'openapi',
        status: 'active',
        actions: [
          {
            path: 'list_issues',
            name: 'List issues',
            description: 'List issues',
            risk: 'read',
            inputSchema: { type: 'object' },
            outputSchema: OUTPUT_SCHEMA,
          },
        ],
      },
    ],
  };
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    urls.push(request.url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json(responseBody);
  }) as unknown as typeof fetch;
});

test('catalog asks for output schemas only when includeOutputSchemas is set', async () => {
  await getConnectorCatalog('p1', { slug: 'ke2e-typed', includeOutputSchemas: true });
  await getConnectorCatalog('p1', { slug: 'ke2e-typed' });
  expect(urls[0]).toBe(
    'http://test.local/v1/connectors/projects/p1/catalog?slug=ke2e-typed&include_output_schemas=true',
  );
  expect(urls[1]).toBe('http://test.local/v1/connectors/projects/p1/catalog?slug=ke2e-typed');
});

test('describe returns the action output schema', async () => {
  const tool = await describeConnectorTool('p1', 'ke2e-typed.list_issues');
  expect(urls[0]).toContain('include_output_schemas=true');
  expect(tool?.outputSchema).toEqual(OUTPUT_SCHEMA);
});

test('callAction posts the canonical payload and types args and output from the registry', async () => {
  responseBody = { ok: true, data: { issues: [{ id: 'I-1' }] }, output: { issues: [{ id: 'I-1' }] } };
  const connectors = connectorDataPlane('p1');

  const result = await connectors.callAction('ke2e-typed', 'list_issues', { team: 'core' });

  expect(bodies[0]).toEqual({ connector: 'ke2e-typed', action: 'list_issues', args: { team: 'core' } });
  const firstId: string | undefined = result.output?.issues[0]?.id;
  expect(firstId).toBe('I-1');

  // @ts-expect-error `team` is required by the generated args type
  await connectors.callAction('ke2e-typed', 'list_issues', { limit: 1 });
  // @ts-expect-error an unknown argument is rejected
  await connectors.callAction('ke2e-typed', 'list_issues', { team: 'core', bad: 1 });
});

test('an action outside the registry falls back to open args and an unknown output', () => {
  const args: ConnectorArgs<'other', 'action'> = { anything: 1 };
  const output: ConnectorResult<'other', 'action'> = 'any value';
  const typed: ConnectorResult<'ke2e-typed', 'list_issues'> = { issues: [] };
  // @ts-expect-error a registered result keeps its shape
  const wrong: ConnectorResult<'ke2e-typed', 'list_issues'> = { issues: 'none' };
  expect([args, output, typed, wrong]).toHaveLength(4);
});
