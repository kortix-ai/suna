import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgentResources } from './agent-resources';

function asset(name: string, value: string | Buffer) {
  const bytes = Buffer.from(value);
  return {
    name,
    source: 'assets/' + name,
    placement: 'worker' as const,
    content: bytes.toString('base64'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

test('declared resources read immutable text, JSON and binary bytes without environment calls', async () => {
  const entries = [
    asset('rules', '{"currency":"EUR"}'),
    asset('binary', Buffer.from([0, 255, 42])),
  ];
  const resources = await createAgentResources(entries);
  expect(await resources.readJson('rules')).toEqual({ currency: 'EUR' });
  expect(await resources.readText('rules')).toBe('{"currency":"EUR"}');
  const bytes = await resources.readBinary('binary');
  bytes[0] = 99;
  expect(Array.from(await resources.readBinary('binary'))).toEqual([0, 255, 42]);
  expect(resources.list().map((entry) => entry.name)).toEqual(['rules', 'binary']);
  await expect(resources.readText('missing')).rejects.toThrow(/not declared/);
  await expect(resources.readText('binary')).rejects.toThrow(/UTF-8/);
  await expect(resources.readJson('binary')).rejects.toThrow();
});

test('resources reject corrupt contents and duplicate names before custom code runs', async () => {
  const file = asset('rules', 'original');
  await expect(
    createAgentResources([{ ...file, content: Buffer.from('different').toString('base64') }]),
  ).rejects.toThrow(/integrity/);
  await expect(createAgentResources([file, file])).rejects.toThrow(/uplicate/);
});
