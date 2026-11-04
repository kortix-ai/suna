import type {
  ConnectorAction,
  ConnectorEffectivePolicy,
  ConnectorPolicyAction,
  ConnectorPolicyRule,
} from '@kortix/sdk';

export type PolicyChoice = 'default' | ConnectorPolicyAction;

/**
 * Which rule list the Tools tab edits: the connector's base rules, or one
 * policy set. In a set, `'default'` means "inherit": the tool has no rule in
 * the set, so the base rules decide (`resolveEffectiveAction` checks the set
 * before the base rules, connectors/policy.ts).
 */
export type PolicyScope = 'base' | 'set';

/** The `effective.source` that marks a decision made in the list being edited. */
function ownSource(scope: PolicyScope): ConnectorEffectivePolicy['source'] {
  return scope === 'set' ? 'policy_set' : 'connector';
}

/**
 * What the control should read for a tool. `risk_default` and `allow_all` are
 * the platform deciding, not the user — showing them as an explicit Allow would
 * claim a choice nobody made, and hide that changing the default moves them.
 */
export function effectiveChoice(
  path: string,
  effective: readonly ConnectorEffectivePolicy[],
  scope: PolicyScope = 'base',
): PolicyChoice {
  const hit = effective.find((e) => e.path === path);
  if (!hit) return 'default';
  return hit.source === ownSource(scope) || hit.source === 'project' ? hit.action : 'default';
}

/**
 * What the Default segment (base rules) or the Inherit segment (a set)
 * resolves to for one tool, so the control can say it: "Default · runs",
 * "Inherit · blocked".
 *
 * - In a set, the base rules decide an inherited tool: `baseEffective` is the
 *   server's answer for the base list.
 * - While the tool is on Default/Inherit, its own `effective` entry is that
 *   answer too (a pattern rule, the risk default, `allow_all`).
 * - Otherwise the connector default (`fallback`) decides.
 */
export function inheritedAction(
  path: string,
  choice: PolicyChoice,
  effective: readonly ConnectorEffectivePolicy[],
  baseEffective: readonly ConnectorEffectivePolicy[],
  scope: PolicyScope,
  fallback: ConnectorPolicyAction,
): ConnectorPolicyAction {
  const base = scope === 'set' ? baseEffective.find((e) => e.path === path) : undefined;
  if (base) return base.action;
  const own = choice === 'default' ? effective.find((e) => e.path === path) : undefined;
  return own?.action ?? fallback;
}

/**
 * Project-scope rules are evaluated first and win
 * (`resolveEffectiveAction`, apps/api/src/connectors/policy.ts:342). Editing the
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
 * Apply one choice to a set of exact tool paths. Pattern rules (`*`, `/re/`)
 * are left untouched: they are a different, coarser instrument, and silently
 * dropping one while the user clicked a group header would be a data loss.
 *
 * `'default'` DELETES the tools' exact rules rather than writing one, which is
 * what returning a tool to the connector default means and what the shipped
 * picker did (`connectors-view.tsx:3128`). Without it a tool could be set and
 * never unset.
 *
 * Replacement is case-INSENSITIVE, because that is how the engine matches: it
 * compiles every glob with the `i` flag (`globToRegex`,
 * apps/api/src/connectors/policy.ts:69), so a rule written `GetPetById` already
 * governs `getpetbyid`. De-duping on exact string equality would leave that
 * rule sitting in front of the new one, dead behind it.
 *
 * The result is a SET of rules, not a wire payload — run it through
 * `orderPolicyRules` before sending, because the runtime is first-match-wins.
 */
export function applyBulkPolicy(
  rules: readonly ConnectorPolicyRule[],
  paths: readonly string[],
  choice: PolicyChoice,
): ConnectorPolicyRule[] {
  const targets = new Set(paths.map((path) => path.toLowerCase()));
  // Only an exact rule can name one tool. A glob is never replaced by a
  // per-tool decision, even when it happens to cover the same tool.
  // A conditional rule (`conditions:` in kortix.yaml) is kept too: a per-tool
  // click has no way to express it, and replacing it would drop the condition.
  const kept = rules.filter((r) => isAdvancedRule(r) || !targets.has(r.match.toLowerCase()));
  if (choice === 'default') return kept;
  return [...kept, ...paths.map((match) => ({ match, action: choice }))];
}

/**
 * Is this matcher a pattern rather than one exact tool path?
 *
 * Same grammar the engine compiles (`compileMatcher`,
 * apps/api/src/connectors/policy.ts:92): a glob if it contains `*`, or an
 * explicit regex when slash-wrapped. Everything else is a literal path.
 */
export function isPatternRule(match: string): boolean {
  return match.includes('*') || /^\/.*\/[a-z]*$/.test(match);
}

/**
 * A rule the per-tool control cannot represent: a pattern, or a rule with
 * argument conditions. Both live in the Advanced editor.
 */
export function isAdvancedRule(rule: ConnectorPolicyRule): boolean {
  return isPatternRule(rule.match) || (rule.conditions?.length ?? 0) > 0;
}

/**
 * Order a rule set for the wire.
 *
 * The runtime takes the FIRST matching rule
 * (`resolveEffectiveAction` -> `firstMatchOrNull`, connectors/policy.ts), so a
 * `*` rule ahead of an exact rule makes that exact rule dead: the user clicks
 * Block on one tool, the request succeeds, and nothing changes. Exact rules
 * therefore go first, patterns after — the same order the shipped panel wrote
 * (`connectors-view.tsx:3106`). Order within each class is preserved, because
 * two overlapping patterns still resolve by authoring order.
 */
export function orderPolicyRules(rules: readonly ConnectorPolicyRule[]): ConnectorPolicyRule[] {
  return [
    ...rules.filter((r) => !isPatternRule(r.match)),
    ...rules.filter((r) => isPatternRule(r.match)),
  ];
}

/**
 * The choice to render for one tool.
 *
 * `effective` is the server resolving every scope through the same function
 * the call gate uses, so it is preferred whenever it covers the tool. It does
 * not always: a connector that exists only in kortix.yaml with no materialized
 * row comes back with `effective: []`
 * (apps/api/src/connectors/db-deps.ts:1151), and older servers omit the field
 * entirely. Falling back to the stored exact rule keeps the control live in
 * both cases instead of showing every tool as unset.
 */
export function toolChoice(
  path: string,
  policies: readonly ConnectorPolicyRule[],
  effective: readonly ConnectorEffectivePolicy[],
  scope: PolicyScope = 'base',
): PolicyChoice {
  if (effective.some((e) => e.path === path)) return effectiveChoice(path, effective, scope);
  // Case-insensitive, like the engine — `GetPetById` governs `getpetbyid`.
  const needle = path.toLowerCase();
  const exact = policies.find((p) => !isAdvancedRule(p) && p.match.toLowerCase() === needle);
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
 *
 * `'default'` DROPS the entry instead of guessing a replacement action. What
 * the tool falls back to — a surviving glob, the risk default, `allow_all` —
 * is the engine's decision, and inventing one here would put a value on screen
 * the server never said. `toolChoice` reads `'default'` from the absence, so
 * the control lands on Default immediately and the refetch fills in the truth.
 */
export function previewEffective(
  effective: readonly ConnectorEffectivePolicy[],
  paths: readonly string[],
  choice: PolicyChoice,
  scope: PolicyScope = 'base',
): ConnectorEffectivePolicy[] {
  const targets = new Set(paths);
  const touched = (entry: ConnectorEffectivePolicy) =>
    targets.has(entry.path) && entry.source !== 'project';
  if (choice === 'default') return effective.filter((entry) => !touched(entry));
  return effective.map((entry) =>
    touched(entry) ? { path: entry.path, action: choice, source: ownSource(scope) } : entry,
  );
}

export type DefaultMode = 'risk' | 'allow_all';

/**
 * What a tool does when no rule names it: the server's default
 * (`resolveEffectiveAction`, connectors/policy.ts). A sensitive connector asks
 * for every tool, `allow_all` runs every tool, and otherwise reads run and
 * writes ask.
 */
export function connectorDefaultAction(
  sensitive: boolean,
  defaultMode: DefaultMode | undefined,
  risk: ConnectorAction['risk'],
): ConnectorPolicyAction {
  if (sensitive) return 'require_approval';
  if (defaultMode === 'allow_all') return 'always_run';
  return risk === 'read' ? 'always_run' : 'require_approval';
}

export interface ToolDecisionSummary {
  total: number;
  block: number;
  ask: number;
  run: number;
  /** Tools the list being edited decides itself (not Default/Inherit, not a project rule). */
  changed: number;
}

/**
 * The counts above the tool list: what each tool does on its next call, and
 * how many tools this list changes. `effective` is the server's answer and
 * wins; `fallback` names what a tool with no entry does.
 */
export function summarizeToolDecisions(
  actions: readonly ConnectorAction[],
  policies: readonly ConnectorPolicyRule[],
  effective: readonly ConnectorEffectivePolicy[],
  scope: PolicyScope,
  fallback: (action: ConnectorAction) => ConnectorPolicyAction,
): ToolDecisionSummary {
  const summary: ToolDecisionSummary = { total: actions.length, block: 0, ask: 0, run: 0, changed: 0 };
  for (const action of actions) {
    const choice = toolChoice(action.path, policies, effective, scope);
    const decided =
      effective.find((entry) => entry.path === action.path)?.action ??
      (choice === 'default' ? fallback(action) : choice);
    if (decided === 'block') summary.block++;
    else if (decided === 'require_approval') summary.ask++;
    else summary.run++;
    if (choice !== 'default' && !isLockedByProject(action.path, effective)) summary.changed++;
  }
  return summary;
}
