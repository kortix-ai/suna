/**
 * What a tool likely does, for grouping and rule templates (`likely_risk` on
 * the admin connector list). The gateway enforces the stored `risk`, never
 * this. The stored risk of an MCP or managed-app tool with no annotation is
 * the fail-closed fallback `write`, so there the name decides
 * (`inferToolRisk`); an HTTP method, a GraphQL mutation or an annotation is
 * authoritative. `destructive` is a write.
 *
 * Rule-set templates: one rule per tool that is not likely a read. A tool
 * whose name says nothing gets the rule: a template never guesses a tool is
 * safe. Tools added later fall to the base rules; apply the template again.
 */
import { inferToolRisk } from '@kortix/shared/tool-risk';
import type { PolicyAction } from './policy';

export const POLICY_SET_TEMPLATES = ['read_only', 'ask_before_writes'] as const;
export type PolicySetTemplate = (typeof POLICY_SET_TEMPLATES)[number];

export function isPolicySetTemplate(value: unknown): value is PolicySetTemplate {
  return (POLICY_SET_TEMPLATES as readonly unknown[]).includes(value);
}

/** Providers whose stored `write` is a fallback, not a fact about the tool. */
const FALLBACK_WRITE_PROVIDERS = new Set(['mcp', 'composio', 'pipedream']);

export function likelyToolRisk(provider: string, path: string, risk: string): 'read' | 'write' | 'unknown' {
  if (risk === 'read') return 'read';
  if (risk !== 'write' || !FALLBACK_WRITE_PROVIDERS.has(provider)) return 'write';
  return inferToolRisk(path);
}

export function templatePolicies(
  template: PolicySetTemplate,
  actions: ReadonlyArray<{ path: string; risk: string }>,
  provider = 'mcp',
): Array<{ match: string; action: PolicyAction }> {
  const action: PolicyAction = template === 'read_only' ? 'block' : 'require_approval';
  return actions
    .filter((a) => likelyToolRisk(provider, a.path, a.risk) !== 'read')
    .map((a) => ({ match: a.path, action }));
}
