import type {
  ConnectorEffectivePolicy,
  ConnectorPolicyAction,
  ConnectorPolicyRule,
} from '@kortix/sdk';

export type PolicyChoice = 'default' | ConnectorPolicyAction;

/**
 * What the control should read for a tool. `risk_default` and `allow_all` are
 * the platform deciding, not the user — showing them as an explicit Allow would
 * claim a choice nobody made, and hide that changing the default moves them.
 */
export function effectiveChoice(
  path: string,
  effective: readonly ConnectorEffectivePolicy[],
): PolicyChoice {
  const hit = effective.find((e) => e.path === path);
  if (!hit) return 'default';
  return hit.source === 'connector' || hit.source === 'project' ? hit.action : 'default';
}

/**
 * Project-scope rules are evaluated first and win
 * (`resolveEffectiveAction`, apps/api/src/executor/policy.ts:342). Editing the
 * connector-scope rule under one would change nothing, so the control is
 * disabled and says where the rule actually lives.
 */
export function isLockedByProject(
  path: string,
  effective: readonly ConnectorEffectivePolicy[],
): boolean {
  return effective.find((e) => e.path === path)?.source === 'project';
}

/**
 * Apply one action to a set of exact tool paths. Pattern rules (`*`, `/re/`)
 * are left untouched: they are a different, coarser instrument, and silently
 * dropping one while the user clicked a group header would be a data loss.
 *
 * The result is a SET of rules, not a wire payload — run it through
 * `orderPolicyRules` before sending, because the runtime is first-match-wins.
 */
export function applyBulkPolicy(
  rules: readonly ConnectorPolicyRule[],
  paths: readonly string[],
  action: ConnectorPolicyAction,
): ConnectorPolicyRule[] {
  const targets = new Set(paths);
  const kept = rules.filter((r) => !targets.has(r.match));
  return [...kept, ...paths.map((match) => ({ match, action }))];
}

/**
 * Is this matcher a pattern rather than one exact tool path?
 *
 * Same grammar the engine compiles (`compileMatcher`,
 * apps/api/src/executor/policy.ts:92): a glob if it contains `*`, or an
 * explicit regex when slash-wrapped. Everything else is a literal path.
 */
export function isPatternRule(match: string): boolean {
  return match.includes('*') || /^\/.*\/[a-z]*$/.test(match);
}

/**
 * Order a rule set for the wire.
 *
 * The runtime takes the FIRST matching rule
 * (`resolveEffectiveAction` -> `firstMatchOrNull`, executor/policy.ts), so a
 * `*` rule ahead of an exact rule makes that exact rule dead: the user clicks
 * Block on one tool, the request succeeds, and nothing changes. Exact rules
 * therefore go first, patterns after — the same order the shipped panel wrote
 * (`connectors-view.tsx:3106`). Order within each class is preserved, because
 * two overlapping patterns still resolve by authoring order.
 */
export function orderPolicyRules(rules: readonly ConnectorPolicyRule[]): ConnectorPolicyRule[] {
  return [...rules.filter((r) => !isPatternRule(r.match)), ...rules.filter((r) => isPatternRule(r.match))];
}

/**
 * The choice to render for one tool.
 *
 * `effective` is the server resolving every scope through the same function
 * the call gate uses, so it is preferred whenever it covers the tool. It does
 * not always: a connector that exists only in kortix.yaml with no materialized
 * row comes back with `effective: []`
 * (apps/api/src/executor/db-deps.ts:1151), and older servers omit the field
 * entirely. Falling back to the stored exact rule keeps the control live in
 * both cases instead of showing every tool as unset.
 */
export function toolChoice(
  path: string,
  policies: readonly ConnectorPolicyRule[],
  effective: readonly ConnectorEffectivePolicy[],
): PolicyChoice {
  if (effective.some((e) => e.path === path)) return effectiveChoice(path, effective);
  const exact = policies.find((p) => p.match === path);
  return exact ? exact.action : 'default';
}

/**
 * What `effective` will look like once the server applies this change — used
 * to keep an optimistic update honest.
 *
 * Without it the control would snap back to the old value between the click
 * and the refetch, because the row reads `effective`, not `policies`. A
 * project-scope entry is left alone: the server would not move it either, and
 * those rows are disabled anyway.
 */
export function previewEffective(
  effective: readonly ConnectorEffectivePolicy[],
  paths: readonly string[],
  action: ConnectorPolicyAction,
): ConnectorEffectivePolicy[] {
  const targets = new Set(paths);
  return effective.map((entry) =>
    targets.has(entry.path) && entry.source !== 'project'
      ? { path: entry.path, action, source: 'connector' as const }
      : entry,
  );
}
