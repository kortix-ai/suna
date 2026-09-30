import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Guard the HTTP route order: a rejected account key must never provision a box.
test('account-scoped keys are denied after visibility and before session start', () => {
  const route = readFileSync(new URL('./session-runtime.ts', import.meta.url), 'utf8');
  const start = route.slice(route.indexOf("path: '/{projectId}/sessions/{sessionId}/start'"), route.indexOf("path: '/{projectId}/sessions/{sessionId}/restart'"));
  const visible = start.indexOf('if (!visible) return');
  const denial = start.indexOf("c.get('authType') === 'apiKey' && c.get('apiKeyType') === 'user'");
  const provision = start.indexOf('await startSession({');
  expect(visible).toBeGreaterThan(0);
  expect(denial).toBeGreaterThan(visible);
  expect(provision).toBeGreaterThan(denial);
  expect(start.slice(denial, provision)).toContain("}, 403)");
});
