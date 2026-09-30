import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const cache = readFileSync(new URL('./session-route-cache.tsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('./project-shell.tsx', import.meta.url), 'utf8');

test('project shell keeps session routes in bounded React Activity trees', () => {
  expect(shell).toContain('<SessionRouteCache>{children}</SessionRouteCache>');
  expect(cache).toContain('MAX_CACHED_SESSIONS = 3');
  expect(cache).toContain("mode={sessionId === entry.id ? 'visible' : 'hidden'}");
  expect(cache).toContain('previous.filter((entry) => entry.id !== sessionId)');
});
