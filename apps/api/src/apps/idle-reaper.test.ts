import { describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const selectChain: Record<string, unknown> = {};
for (const name of ['from', 'innerJoin', 'where']) selectChain[name] = () => selectChain;
selectChain.limit = async () => {
  calls.push('select');
  return [];
};
mock.module('../shared/db', () => ({
  db: {
    update: () => ({
      set: (values: { status?: string }) => {
        calls.push(`update:${values.status}`);
        return { where: async () => [] };
      },
    }),
    select: () => selectChain,
  },
}));

const { runAppIdleReaper } = await import('./idle-reaper');

describe('app idle reaper', () => {
  test('hands a stale `stopping` runtime back to `running` before it selects idle runtimes', async () => {
    await runAppIdleReaper(new Date());
    // The always-on keep-alive pass (`runAppKeepAlive`) runs after the idle pass
    // and issues its own selects; only the idle pass's order is asserted here.
    expect(calls.slice(0, 2)).toEqual(['update:running', 'select']);
  });
});
