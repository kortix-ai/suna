import { describe, expect, test } from 'bun:test';
import { resolveSessionManagedModel } from './session-model';
import type { ManagedModel } from '../models/managed-models';

function served(...ids: string[]): ManagedModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    pricing: { inputPerMillion: 1, outputPerMillion: 1 },
    vision: true,
    limit: { context: 200_000, output: 32_000 },
  })) as ManagedModel[];
}

// The caller (session-model-repoint.ts) asks only for a RETIRED stored id.
// No successor is hardcoded: the project default, then the platform default
// (the configured model when Platinum serves it, else Platinum's first).
describe('resolveSessionManagedModel', () => {
  const lineup = served('deepseek-v4.1-flash', 'glm-5.3-flash');

  test('a retired id moves to the project default', () => {
    expect(resolveSessionManagedModel('kimi-k3', lineup, 'glm-5.3-flash', 'deepseek-v4.1-flash')).toEqual({
      kind: 'repoint', to: 'glm-5.3-flash', reason: 'project_default',
    });
  });

  // The reason must NOT say `project_default` when the project never set one:
  // an audit row that claims it did sends the reader to the wrong setting.
  test('with no project default it moves to the platform default, named as such', () => {
    expect(resolveSessionManagedModel('glm-5.2', lineup, null, 'deepseek-v4.1-flash')).toEqual({
      kind: 'repoint', to: 'deepseek-v4.1-flash', reason: 'platform_default',
    });
  });

  test('with no default at all it is kept: the turn error names the real cause', () => {
    // The floor is supplied by the CALLER; the pure decision never invents one.
    expect(resolveSessionManagedModel('glm-5.2', lineup, null)).toEqual({ kind: 'kept' });
  });

  test('never re-points a retired id onto itself', () => {
    expect(resolveSessionManagedModel('grok-4.6', lineup, 'grok-4.6')).toEqual({ kind: 'kept' });
    expect(resolveSessionManagedModel('grok-4.6', lineup, null, 'grok-4.6')).toEqual({ kind: 'kept' });
  });
});
