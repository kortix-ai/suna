import { expect, mock, test } from 'bun:test';
import { connectorDataPlane } from '../../client/project-connectors';
import { configureKortix } from '../../http/config';

// A browser App calls the API through its own origin: `backendUrl` is the
// relative `/_kortix/api/v1` (sdk/connectors.mdx). The SDK must send that
// path as-is, never resolve it against a default host.
test('a relative backendUrl sends the connector call to the same-origin path with the bearer', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  configureKortix({ backendUrl: '/_kortix/api/v1', getToken: async () => 'kortix_oat_viewer' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    seen.push({ url, auth: headers.get('authorization') });
    return Response.json({ ok: true, output: { rows: [] } });
  }) as unknown as typeof fetch;

  const result = await connectorDataPlane('p1').call('crm.list_deals', {});

  expect(seen).toEqual([
    { url: '/_kortix/api/v1/connectors/projects/p1/call', auth: 'Bearer kortix_oat_viewer' },
  ]);
  expect(result.ok).toBe(true);
});
