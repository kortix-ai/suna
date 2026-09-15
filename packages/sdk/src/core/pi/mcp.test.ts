import { expect, test } from 'bun:test';
import { validateStdioMcpServers } from './mcp';

test('MCP config size counts UTF-8 bytes and rejects non-record objects', () => {
  expect(() =>
    validateStdioMcpServers({
      server: {
        type: 'local',
        command: ['node', ...Array(4).fill('界'.repeat(3000))],
      },
    }),
  ).toThrow(/32 KiB/);
  expect(() => validateStdioMcpServers(new Date())).toThrow();
  expect(() =>
    validateStdioMcpServers({
      server: { type: 'local', command: ['node'], environment: new Date() },
    }),
  ).toThrow();
});

test('MCP validation preserves exact arguments and rejects oversized maps, strings, and unsafe names', () => {
  const config = {
    local: {
      type: 'local',
      command: ['node', 'arg with spaces', '$(false)', ''],
      timeout: 60000,
    },
  };
  const original = structuredClone(config);
  expect(() => validateStdioMcpServers(config)).not.toThrow();
  expect(config).toEqual(original);
  for (const invalid of [
    Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`server${i}`, config.local]),
    ),
    { '-bad': config.local },
    { server: { ...config.local, command: ['node', 'x'.repeat(8193)] } },
    { server: { ...config.local, command: ['node', 'bad\0arg'] } },
    { server: { ...config.local, environment: { 'BAD-KEY': 'value' } } },
    { server: { ...config.local, timeout: 1.5 } },
    { server: { ...config.local, cwd: '' } },
  ])
    expect(() => validateStdioMcpServers(invalid)).toThrow();
});
