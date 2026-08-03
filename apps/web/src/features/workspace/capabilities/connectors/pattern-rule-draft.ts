import type { ConnectorPolicyAction, ConnectorPolicyRule } from '@kortix/sdk';

import { orderPolicyRules } from './tool-policy';

/** One editable row in the Advanced editor's pattern-rule list. `id` is a
 *  render key only — it never reaches the wire and never enters a signature. */
export interface PatternDraftRow {
  id: string;
  match: string;
  action: ConnectorPolicyAction;
}

/**
 * A content signature for a set of pattern rules, immune to the one reordering
 * the write path performs.
 *
 * Two callers depend on this in `rung-permissions.tsx`: the reseed guard, which
 * refuses to rebuild the draft while the server's pattern set is unchanged, and
 * the dirty check behind Discard/Save.
 *
 * `orderPolicyRules` is applied FIRST, and that is the whole point. The
 * optimistic cache write puts `orderPolicyRules(write.rules)` into
 * `['connector-policies', …]` on every per-tool click, which hoists every
 * non-pattern rule ahead of every pattern rule. A signature that encoded raw
 * array position therefore changed when nothing about the rules did:
 *
 *   server order   [{delete_*}, {retired_tool}]   -> "delete_*=…\nretired_tool=…"
 *   after a click  [{retired_tool}, {delete_*}]   -> "retired_tool=…\ndelete_*=…"
 *
 * The reseed guard read that as "the server's pattern set changed", rebuilt the
 * draft, and threw away whatever the user had half-typed into a new row. Since
 * `orderPolicyRules` is exactly the transformation being defended against,
 * normalizing through it is immune by construction — and, unlike a plain sort,
 * it still reports a genuine reorder WITHIN either class, which the engine
 * resolves by authoring order and which the user can still cause by deleting a
 * row and re-adding it.
 */
export function signPatternRules(rules: readonly ConnectorPolicyRule[]): string {
  return orderPolicyRules(rules)
    .map((rule) => `${rule.match}=${rule.action}`)
    .join('\n');
}

/** The draft rows a rule set seeds, in the order the rules arrived. */
export function seedPatternDraft(
  rules: readonly ConnectorPolicyRule[],
  nextId: () => string,
): PatternDraftRow[] {
  return rules.map((rule) => ({ id: nextId(), match: rule.match, action: rule.action }));
}

/** The wire form of a draft: blank rows dropped, every match trimmed, `id`
 *  gone. Shared by the dirty check and the save, so the two can never disagree
 *  about what "unchanged" means. */
export function draftToRules(draft: readonly PatternDraftRow[]): ConnectorPolicyRule[] {
  return draft
    .filter((row) => row.match.trim())
    .map((row) => ({ match: row.match.trim(), action: row.action }));
}
