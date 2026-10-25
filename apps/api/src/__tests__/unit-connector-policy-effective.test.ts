/**
 * `resolveEffectiveRule`: the gateway's decision plus the rule that made it,
 * which `GET …/connectors/{slug}/policies` answers per tool in `effective`.
 */
import { describe, expect, test } from 'bun:test';
import { resolveEffectiveAction, resolveEffectiveRule } from '../connectors/policy';

const base = {
  projectPolicies: [{ match: 'linear.delete_*', action: 'block' as const, position: 0 }],
  connectorPolicies: [{ match: 'create_*', action: 'always_run' as const, position: 0 }],
  setPolicies: [{ match: 'create_issue', action: 'require_approval' as const, position: 0 }],
  defaultMode: 'risk' as const,
};

describe('resolveEffectiveRule', () => {
  test('names the rule of the scope that decided, and none for the default', () => {
    const at = (relPath: string, risk: 'read' | 'write' | 'destructive', input: Partial<typeof base> = {}) =>
      resolveEffectiveRule({ ...base, ...input, fullPath: `linear.${relPath}`, relPath, risk });
    expect(at('delete_issue', 'destructive')).toMatchObject({ action: 'block', source: 'project', rule: { match: 'linear.delete_*' } });
    expect(at('create_issue', 'write')).toMatchObject({ action: 'require_approval', source: 'policy_set', rule: { match: 'create_issue' } });
    expect(at('create_issue', 'write', { setPolicies: [] })).toMatchObject({ action: 'always_run', source: 'connector', rule: { match: 'create_*' } });
    const fallback = at('list_issues', 'read');
    expect(fallback).toEqual({ action: 'always_run', source: 'risk_default' });
  });

  test('resolveEffectiveAction answers the same decision without the rule', () => {
    const input = { ...base, fullPath: 'linear.create_issue', relPath: 'create_issue', risk: 'write' as const };
    expect(resolveEffectiveAction(input)).toEqual({ action: 'require_approval', source: 'policy_set' });
  });
});
