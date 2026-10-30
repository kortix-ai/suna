import { describe, expect, test } from 'bun:test';
import { isWorkflowRunnerContext, WORKFLOW_RUN_ID_KEY } from './workflow-runner';

describe('isWorkflowRunnerContext (the one My Kortix → My Kortix session the API allows)', () => {
  test('a runtime_context that names a run is a runner', () => {
    expect(isWorkflowRunnerContext({ [WORKFLOW_RUN_ID_KEY]: 'run-1', 'kortix.subagent.depth': 1 })).toBe(true);
  });

  test('anything else is not: no key, an empty id, a non-string id, no object', () => {
    expect(isWorkflowRunnerContext({ 'kortix.subagent.depth': 1 })).toBe(false);
    expect(isWorkflowRunnerContext({ [WORKFLOW_RUN_ID_KEY]: '  ' })).toBe(false);
    expect(isWorkflowRunnerContext({ [WORKFLOW_RUN_ID_KEY]: 7 })).toBe(false);
    expect(isWorkflowRunnerContext(null)).toBe(false);
    expect(isWorkflowRunnerContext([WORKFLOW_RUN_ID_KEY])).toBe(false);
  });
});
