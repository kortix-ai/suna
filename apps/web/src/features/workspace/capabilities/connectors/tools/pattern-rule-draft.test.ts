import type { ConnectorPolicyAction, ConnectorPolicyRule } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  draftToRules,
  type PatternDraftRow,
  seedPatternDraft,
  signPatternRules,
} from './pattern-rule-draft';
import { applyBulkPolicy, isPatternRule, orderPolicyRules } from './tool-policy';

/**
 * The tools the connector currently reports. `retired_tool` is deliberately
 * NOT among them: a rule left behind by a tool the connector no longer lists
 * falls into the Advanced editor beside the patterns
 * (`connector-tools.tsx`'s `advancedRules`), and it is that mixed set —
 * one exact rule, one pattern — that `orderPolicyRules` reorders.
 */
const LIVE_TOOLS = new Set(['getpetbyid']);

/** `connector-tools.tsx`'s `advancedRules`, with the same predicate. */
const advancedRulesOf = (policies: readonly ConnectorPolicyRule[]): ConnectorPolicyRule[] =>
  policies.filter((rule) => isPatternRule(rule.match) || !LIVE_TOOLS.has(rule.match));

/**
 * The Advanced editor's draft state and its reseed guard, in the same order
 * the component runs them: derive `advancedRules`, sign them, bail if the
 * signature is unchanged, otherwise rebuild the draft from the server's rules.
 */
class AdvancedEditor {
  draft: PatternDraftRow[] = [];
  private seeded: string | null = null;
  private seq = 0;
  private readonly nextId = () => `pattern-${++this.seq}`;

  /** A `['connector-policies', …]` cache value reaching the effect. */
  receive(policies: readonly ConnectorPolicyRule[]): void {
    const rules = advancedRulesOf(policies);
    const signature = signPatternRules(rules);
    if (this.seeded === signature) return;
    this.seeded = signature;
    this.draft = seedPatternDraft(rules, this.nextId);
  }

  /** Add rule, then type into the new row. */
  type(match: string, action: ConnectorPolicyAction): void {
    this.draft = [...this.draft, { id: this.nextId(), match, action }];
  }

  get matches(): string[] {
    return this.draft.map((row) => row.match);
  }

  dirtyAgainst(policies: readonly ConnectorPolicyRule[]): boolean {
    return signPatternRules(draftToRules(this.draft)) !== signPatternRules(advancedRulesOf(policies));
  }
}

/** Authoring order from the server: the pattern FIRST, then the stale exact
 *  rule. This is the order the manifest stores and the API returns; nothing
 *  normalizes it on read. */
const SERVED: ConnectorPolicyRule[] = [
  { match: 'delete_*', action: 'block' },
  { match: 'retired_tool', action: 'block' },
];

describe('the Advanced editor survives a per-tool click', () => {
  test('the optimistic write really does reorder the rules the editor reads', () => {
    // The premise of the defect, asserted rather than assumed: `onMutate`
    // writes `orderPolicyRules(...)` into the same query key, and that hoists
    // every non-pattern rule ahead of every pattern rule.
    const optimistic = orderPolicyRules(applyBulkPolicy(SERVED, ['getpetbyid'], 'block'));
    expect(optimistic.map((rule) => rule.match)).toEqual([
      'retired_tool',
      'getpetbyid',
      'delete_*',
    ]);
    expect(advancedRulesOf(optimistic).map((rule) => rule.match)).toEqual([
      'retired_tool',
      'delete_*',
    ]);
    expect(advancedRulesOf(SERVED).map((rule) => rule.match)).toEqual([
      'delete_*',
      'retired_tool',
    ]);
  });

  test('a half-typed pattern rule is NOT wiped by setting one tool’s policy', () => {
    const editor = new AdvancedEditor();
    editor.receive(SERVED);
    expect(editor.matches).toEqual(['delete_*', 'retired_tool']);

    // The user clicks Add rule and types `send_` into the new row.
    editor.type('send_', 'require_approval');
    expect(editor.dirtyAgainst(SERVED)).toBe(true);

    // Before saving it, they set one tool's policy in the list above. The
    // optimistic cache write lands, reordered.
    editor.receive(orderPolicyRules(applyBulkPolicy(SERVED, ['getpetbyid'], 'block')));

    expect(editor.matches).toEqual(['delete_*', 'retired_tool', 'send_']);
  });

  test('and Save is still offered afterwards, so the typed rule is reachable', () => {
    const editor = new AdvancedEditor();
    editor.receive(SERVED);
    editor.type('send_', 'require_approval');
    const optimistic = orderPolicyRules(applyBulkPolicy(SERVED, ['getpetbyid'], 'block'));
    editor.receive(optimistic);

    expect(editor.dirtyAgainst(optimistic)).toBe(true);
    expect(draftToRules(editor.draft)).toEqual([
      { match: 'delete_*', action: 'block' },
      { match: 'retired_tool', action: 'block' },
      { match: 'send_', action: 'require_approval' },
    ]);
  });

  test('an untouched editor is not reported dirty by the reorder either', () => {
    const editor = new AdvancedEditor();
    editor.receive(SERVED);
    const optimistic = orderPolicyRules(applyBulkPolicy(SERVED, ['getpetbyid'], 'block'));
    editor.receive(optimistic);

    expect(editor.dirtyAgainst(optimistic)).toBe(false);
  });
});

describe('the guard still notices a real change', () => {
  test('a pattern rule added on the server reseeds the draft', () => {
    const editor = new AdvancedEditor();
    editor.receive(SERVED);
    editor.receive([...SERVED, { match: 'send_*', action: 'always_run' }]);

    expect(editor.matches).toEqual(['delete_*', 'retired_tool', 'send_*']);
  });

  test('a changed action on an existing rule reseeds the draft', () => {
    const editor = new AdvancedEditor();
    editor.receive(SERVED);
    editor.receive([{ match: 'delete_*', action: 'always_run' }, SERVED[1]!]);

    expect(editor.draft.map((row) => row.action)).toEqual(['always_run', 'block']);
  });

  test('reordering two patterns is still a change — the engine takes the first match', () => {
    const a: ConnectorPolicyRule = { match: 'delete_*', action: 'block' };
    const b: ConnectorPolicyRule = { match: 'send_*', action: 'always_run' };
    expect(signPatternRules([a, b])).not.toBe(signPatternRules([b, a]));
  });
});

describe('draftToRules', () => {
  test('drops blank rows and trims every match, so a stray space is not a rule', () => {
    expect(
      draftToRules([
        { id: '1', match: '  delete_*  ', action: 'block' },
        { id: '2', match: '   ', action: 'block' },
        { id: '3', match: '', action: 'require_approval' },
      ]),
    ).toEqual([{ match: 'delete_*', action: 'block' }]);
  });

  test('the row id never reaches the wire', () => {
    const [rule] = draftToRules([{ id: 'pattern-9', match: 'send_*', action: 'always_run' }]);
    expect(Object.keys(rule!).sort()).toEqual(['action', 'match']);
  });
});
