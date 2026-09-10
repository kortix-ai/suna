import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { decodeCompiledAgentResources } from './compiled-agent-resources';

const file = (extra = {}) => ({
  placement: 'worker',
  name: 'rules',
  source: 'rules.json',
  content: 'eA==',
  size: 1,
  sha256: createHash('sha256').update('x').digest('hex'),
  ...extra,
});

test('compiled resources validate both placements and return exact bytes', async () => {
  const resources = await decodeCompiledAgentResources([
    file(),
    file({ placement: 'environment', name: undefined, target: '/workspace/x', mode: 'seed' }),
  ]);
  expect(resources.map((resource) => Array.from(resource.bytes))).toEqual([[120], [120]]);
});

test.each([
  null,
  {},
  [null],
  [file({ placement: 'unknown' })],
  [file({ name: '../x' })],
  [file({ content: 'eA' })],
  [file({ content: 'eA==\n' })],
  [file({ size: 2 })],
  [file({ size: -1 })],
  [file({ sha256: '0'.repeat(64) })],
  [file({ source: '../x' })],
  [file({ extra: true })],
  [file(), file()],
  [file({ placement: 'environment', name: undefined, target: '/etc/passwd', mode: 'seed' })],
  [file({ placement: 'environment', name: undefined, target: '/workspace/x', mode: 'read_only' })],
  [
    file({
      placement: 'environment',
      name: undefined,
      target: '/workspace/x',
      mode: 'seed',
      content: 'bad',
    }),
  ],
])('compiled resource manifest rejects invalid input before installation: %j', async (input) => {
  await expect(decodeCompiledAgentResources(input)).rejects.toThrow(/resource/i);
});

test('compiled resources bound count and aggregate decoded size before allocation', async () => {
  await expect(
    decodeCompiledAgentResources(Array.from({ length: 129 }, () => file())),
  ).rejects.toThrow(/128/);
  await expect(decodeCompiledAgentResources([file({ size: 8 * 1024 * 1024 + 1 })])).rejects.toThrow(
    /8 MiB/,
  );
});

test('empty files and the full 8 MiB boundary decode without recursive base64 matching', async () => {
  for (const size of [0, 8 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, 0xab);
    const result = await decodeCompiledAgentResources([
      file({
        content: bytes.toString('base64'),
        size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ]);
    expect(result[0]!.bytes.byteLength).toBe(size);
    expect(Buffer.from(result[0]!.bytes)).toEqual(bytes);
  }
});
