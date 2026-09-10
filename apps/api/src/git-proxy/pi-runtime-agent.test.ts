import { expect, test } from 'bun:test';
import { resolvePiRuntimeAgent } from './pi-runtime-agent';

test('a session can download only its own agent, including when the query supplies a name', async () => {
  const load = async () => 'reader';
  expect(await resolvePiRuntimeAgent('session', undefined, load)).toBe('reader');
  expect(await resolvePiRuntimeAgent('session', 'reader', load)).toBe('reader');
  await expect(resolvePiRuntimeAgent('session', 'admin', load)).rejects.toThrow(/session agent/);
  await expect(resolvePiRuntimeAgent('session', '', load)).rejects.toThrow(/session agent/);
  await expect(resolvePiRuntimeAgent('missing', undefined, async () => '')).rejects.toThrow(
    /session agent/,
  );
});

test('a project owner can select an agent or use the compiled project default without a session lookup', async () => {
  const load = async () => {
    throw new Error('must not query a session');
  };
  expect(await resolvePiRuntimeAgent(null, 'admin', load)).toBe('admin');
  expect(await resolvePiRuntimeAgent(null, undefined, load)).toBe('');
});
