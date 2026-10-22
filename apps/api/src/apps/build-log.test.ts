import { expect, test } from 'bun:test';
import { BUILD_LOG_LIMITS, createBuildLog, type BuildLogRow } from './build-log';

function recorder() {
  const batches: BuildLogRow[][] = [];
  return { batches, insert: async (rows: BuildLogRow[]) => { batches.push(rows); } };
}

test('20,000 build lines become at most 5,001 rows in at most 30 inserts, head and tail kept in order', async () => {
  const { batches, insert } = recorder();
  const log = createBuildLog('deployment', insert);
  for (let i = 0; i < 20_000; i += 1) log.line(`line ${i}`);
  await log.close();

  const rows = batches.flat();
  expect(rows.length).toBe(BUILD_LOG_LIMITS.HEAD_LINES + 1 + BUILD_LOG_LIMITS.TAIL_LINES);
  expect(batches.length).toBeLessThanOrEqual(30);
  expect(batches.every((batch) => batch.length <= BUILD_LOG_LIMITS.FLUSH_LINES)).toBe(true);
  expect(rows[0]).toEqual({ type: 'build_log', message: 'line 0' });
  expect(rows[2_499]!.message).toBe('line 2499');
  expect(rows[2_500]).toMatchObject({ type: 'log_truncated', data: { dropped: 15_000 } });
  expect(rows[2_501]!.message).toBe('line 17500');
  expect(rows.at(-1)!.message).toBe('line 19999');
});

test('a short build writes every line and no truncation event', async () => {
  const { batches, insert } = recorder();
  const log = createBuildLog('deployment', insert);
  for (let i = 0; i < 450; i += 1) log.line(`line ${i}`);
  await log.close();
  const rows = batches.flat();
  expect(rows.map((row) => row.message)).toEqual(Array.from({ length: 450 }, (_, i) => `line ${i}`));
  expect(rows.some((row) => row.type === 'log_truncated')).toBe(false);
  expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
});

test('a partial batch is written after FLUSH_EVERY_MS without close', async () => {
  const { batches, insert } = recorder();
  const log = createBuildLog('deployment', insert);
  log.line('first');
  expect(batches.length).toBe(0);
  await Bun.sleep(BUILD_LOG_LIMITS.FLUSH_EVERY_MS + 100);
  expect(batches).toEqual([[{ type: 'build_log', message: 'first' }]]);
  await log.close();
  expect(batches.length).toBe(1);
});

test('a failed insert is logged and later batches still go out', async () => {
  const written: BuildLogRow[][] = [];
  let calls = 0;
  const log = createBuildLog('deployment', async (rows) => {
    calls += 1;
    if (calls === 1) throw new Error('db down');
    written.push(rows);
  });
  for (let i = 0; i < 400; i += 1) log.line(`line ${i}`);
  await log.close();
  expect(calls).toBe(2);
  expect(written.flat()[0]!.message).toBe('line 200');
});

test('a line longer than LINE_CHARS is cut', async () => {
  const { batches, insert } = recorder();
  const log = createBuildLog('deployment', insert);
  log.line('x'.repeat(10_000));
  await log.close();
  expect(batches[0]![0]!.message.length).toBe(BUILD_LOG_LIMITS.LINE_CHARS);
});
