import { describe, expect, test } from 'bun:test';

import { backgroundRunners } from './use-session-agents.ts';

describe('backgroundRunners', () => {
  test('a finished background run is read from its runner too: the parent copy lists none of its agents', () => {
    const runs = [
      { runId: 'r3', status: 'done', runnerSessionId: 'kses_c' },
      { runId: 'r2', status: 'running', runnerSessionId: 'kses_b' },
      { runId: 'r1', status: 'failed', runnerSessionId: 'kses_a' },
      { runId: 'r0', status: 'done', runnerSessionId: 'kses_z' },
    ] as never;
    expect(backgroundRunners(runs)).toEqual(['kses_c', 'kses_b', 'kses_a']);
  });
});
