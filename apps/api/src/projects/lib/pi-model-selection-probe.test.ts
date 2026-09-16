import { expect, test } from 'bun:test';
import { piModelSelectionSupported } from './pi-model-selection-probe';

test('only a Pi worker advertising next-prompt selection accepts a live model change', async () => {
  let value: unknown = { engine: 'pi' };
  let status = 200;
  const server = Bun.serve({ port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe('/kortix/health');
    expect(request.headers.get('x-provider')).toBe('probe');
    return Response.json(value, { status });
  } });
  try {
    const probe = () => piModelSelectionSupported(server.url.toString(), { 'x-provider': 'probe' });
    expect(await probe()).toBe(false);
    value = { engine: 'opencode', session_model_selection: 'next-prompt-v1' };
    expect(await probe()).toBe(false);
    value = { engine: 'pi', session_model_selection: 'next-prompt-v1' };
    expect(await probe()).toBe(true);
    status = 503;
    expect(await probe()).toBe(false);
  } finally { server.stop(true); }
  expect(await piModelSelectionSupported('http://127.0.0.1:1', {})).toBe(false);
});
