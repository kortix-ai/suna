import { expect, test } from 'bun:test';

test('global error boundary never renders or reloads a session-starting screen', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  expect(source).not.toContain('Starting your session');
  expect(source).not.toContain('isRuntimeNotReadyError');
  expect(source).not.toContain('setTimeout');
});
