import { expect, test } from 'bun:test';
import { deploymentEventsAsLogs } from './logs';

test('deployment events remain readable before a runtime exists', () => {
  const response = deploymentEventsAsLogs([
    {
      type: 'build_started',
      message: 'Building image',
      createdAt: new Date('2026-08-07T16:00:00.000Z'),
    },
    {
      type: 'build_log',
      message: 'RUN pnpm build',
      createdAt: new Date('2026-08-07T16:00:01.000Z'),
    },
  ], 0, 200);

  expect(response).toEqual({
    entries: [
      {
        cursor: 1,
        time: '2026-08-07T16:00:00.000Z',
        source: 'kortix',
        line: '[build_started] Building image',
      },
      {
        cursor: 2,
        time: '2026-08-07T16:00:01.000Z',
        source: 'build',
        line: 'RUN pnpm build',
      },
    ],
    next_cursor: 2,
  });
});
