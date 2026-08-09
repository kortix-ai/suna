import { describe, expect, test } from 'bun:test';
import {
  TASK_HARNESS_OVERRIDES_MAX_BYTES,
  TaskLivenessConflictError,
  projectTaskWorkerInitialPrompt,
} from './generated-state-store';

describe('task worker initial prompt', () => {
  const base = {
    projectId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    prompt: 'Complete the assigned task.',
  };

  test('prepends only this task local harness overrides as bounded JSON', () => {
    const prompt = projectTaskWorkerInitialPrompt({
      ...base,
      result: {
        harness_overrides: {
          verification: { adversarial_review: true },
          retries: 2,
        },
      },
    });

    expect(prompt).toStartWith('[BEGIN SERVER-OWNED TASK HARNESS OVERRIDES JSON V1]');
    expect(prompt).toContain(`task_id=${base.taskId}`);
    expect(prompt).toContain(
      JSON.stringify({
        verification: { adversarial_review: true },
        retries: 2,
      }),
    );
    expect(prompt).toEndWith(base.prompt);
  });

  test('does not expose another task result when this task has no overrides', () => {
    expect(
      projectTaskWorkerInitialPrompt({
        ...base,
        result: {},
        prompt: base.prompt,
      }),
    ).toBe(base.prompt);
    expect(
      projectTaskWorkerInitialPrompt({
        ...base,
        taskId: '33333333-3333-4333-8333-333333333333',
        result: { unrelated_task_overrides: { secret: 'do-not-copy' } },
        prompt: base.prompt,
      }),
    ).toBe(base.prompt);
  });

  test('rejects an override block above the server byte limit', () => {
    expect(() =>
      projectTaskWorkerInitialPrompt({
        ...base,
        result: {
          harness_overrides: {
            procedure: 'x'.repeat(TASK_HARNESS_OVERRIDES_MAX_BYTES),
          },
        },
      }),
    ).toThrow(TaskLivenessConflictError);
  });
});
