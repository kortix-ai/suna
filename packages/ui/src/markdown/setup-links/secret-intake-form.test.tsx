import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SecretIntakeForm } from './secret-intake-form';

const originalFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  globalThis.fetch = originalFetch;
});

test.each(['connector', 'runtime', undefined] as const)('shows %s delivery before accepting a value', async (scope) => {
  globalThis.fetch = Object.assign(async () => Response.json({
    project_name: 'Synthetic project', fields: [{ name: 'DEMO_KEY', label: null, description: null }],
    expires_at: '2099-01-01T00:00:00Z', scope,
  }), { preconnect: originalFetch.preconnect });
  await act(async () => { renderer = create(<SecretIntakeForm token="synthetic-token" compact />); });
  const html = JSON.stringify(renderer?.toJSON());
  expect(html).toContain(scope === 'runtime' ? 'Delivery: runtime' : scope === 'connector' ? 'Delivery: connector' : 'Delivery scope is unavailable');
  expect(html).toContain('DEMO_KEY');
  if (scope === 'runtime') expect(html).toContain('Agent code can read it');
  if (scope === 'connector') expect(html).toContain('never enters the sandbox environment');
});

test('the full form points the encryption promise at the disclosed delivery scope', async () => {
  globalThis.fetch = Object.assign(async () => Response.json({
    project_name: 'Synthetic project', fields: [{ name: 'DEMO_KEY', label: null, description: null }],
    expires_at: '2099-01-01T00:00:00Z', scope: 'connector',
  }), { preconnect: originalFetch.preconnect });
  await act(async () => { renderer = create(<SecretIntakeForm token="synthetic-token" />); });
  const html = JSON.stringify(renderer?.toJSON());
  expect(html).toContain('Encrypted at rest. Delivery follows the scope shown above.');
  expect(html).toContain('Delivery: connector');
});
