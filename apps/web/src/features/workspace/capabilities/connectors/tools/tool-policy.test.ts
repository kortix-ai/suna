import type { ConnectorEffectivePolicy } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  applyBulkPolicy,
  effectiveChoice,
  isLockedByProject,
  isPatternRule,
  orderPolicyRules,
  previewEffective,
  toolChoice,
} from './tool-policy';

const eff = (
  path: string,
  action: ConnectorEffectivePolicy['action'],
  source: ConnectorEffectivePolicy['source'],
): ConnectorEffectivePolicy => ({ path, action, source });

describe('effectiveChoice', () => {
  test('an explicit connector rule shows as that action', () => {
    expect(effectiveChoice('send_email', [eff('send_email', 'block', 'connector')])).toBe('block');
  });
  test('a risk default shows as default, not as an explicit choice', () => {
    expect(effectiveChoice('get_mail', [eff('get_mail', 'always_run', 'risk_default')])).toBe(
      'default',
    );
  });
  test('allow_all is also a default, not a choice the user made', () => {
    expect(effectiveChoice('get_mail', [eff('get_mail', 'always_run', 'allow_all')])).toBe(
      'default',
    );
  });
  test('an unknown path is default', () => {
    expect(effectiveChoice('nope', [])).toBe('default');
  });
  test('a project rule shows its action — that is what actually happens', () => {
    expect(effectiveChoice('send_email', [eff('send_email', 'block', 'project')])).toBe('block');
  });
});

describe('isLockedByProject', () => {
  test('a project-scope rule cannot be overridden here', () => {
    expect(isLockedByProject('send_email', [eff('send_email', 'block', 'project')])).toBe(true);
  });
  test('a connector-scope rule is editable', () => {
    expect(isLockedByProject('send_email', [eff('send_email', 'block', 'connector')])).toBe(false);
  });
  test('no policy is editable', () => {
    expect(isLockedByProject('send_email', [])).toBe(false);
  });
});

describe('applyBulkPolicy', () => {
  test('sets every named path to the action', () => {
    expect(applyBulkPolicy([], ['a', 'b'], 'block')).toEqual([
      { match: 'a', action: 'block' },
      { match: 'b', action: 'block' },
    ]);
  });
  test('replaces an existing exact-match rule rather than duplicating it', () => {
    const out = applyBulkPolicy([{ match: 'a', action: 'always_run' }], ['a'], 'block');
    expect(out).toEqual([{ match: 'a', action: 'block' }]);
  });
  test('leaves rules for other paths alone', () => {
    const out = applyBulkPolicy([{ match: 'z', action: 'block' }], ['a'], 'always_run');
    expect(out).toEqual([
      { match: 'z', action: 'block' },
      { match: 'a', action: 'always_run' },
    ]);
  });
  test('preserves pattern rules — a glob is not an exact path', () => {
    const out = applyBulkPolicy([{ match: '*', action: 'require_approval' }], ['a'], 'block');
    expect(out).toEqual([
      { match: '*', action: 'require_approval' },
      { match: 'a', action: 'block' },
    ]);
  });
  test('does not mutate the input list', () => {
    const rules = [{ match: 'a', action: 'always_run' } as const];
    applyBulkPolicy(rules, ['a'], 'block');
    expect(rules).toEqual([{ match: 'a', action: 'always_run' }]);
  });

  // The engine compiles every matcher with the `i` flag (`globToRegex`,
  // apps/api/src/connectors/policy.ts:69), so `GetPetById` already governs
  // `getpetbyid`. De-duping on exact string equality would leave the old rule
  // in front of the new one, dead behind it — the same defect class as the
  // ordering bug.
  test('replaces a mis-cased rule for the same tool, not stacks behind it', () => {
    const out = applyBulkPolicy(
      [{ match: 'GetPetById', action: 'block' }],
      ['getpetbyid'],
      'always_run',
    );
    expect(out).toEqual([{ match: 'getpetbyid', action: 'always_run' }]);
  });

  test('case folding does not reach pattern rules', () => {
    const out = applyBulkPolicy([{ match: 'Get*', action: 'block' }], ['getpetbyid'], 'always_run');
    expect(out).toEqual([
      { match: 'Get*', action: 'block' },
      { match: 'getpetbyid', action: 'always_run' },
    ]);
  });

  // Fourth state, fourth choice. Without this a tool can be set but never
  // unset — the shipped picker's `Default` deletes the rule
  // (`connectors-view.tsx:3128`) and this must too.
  test("'default' deletes the tool's exact rule instead of writing one", () => {
    expect(applyBulkPolicy([{ match: 'a', action: 'block' }], ['a'], 'default')).toEqual([]);
  });

  test("'default' still leaves pattern rules and other tools alone", () => {
    const out = applyBulkPolicy(
      [
        { match: '*', action: 'require_approval' },
        { match: 'a', action: 'block' },
        { match: 'b', action: 'block' },
      ],
      ['a'],
      'default',
    );
    expect(out).toEqual([
      { match: '*', action: 'require_approval' },
      { match: 'b', action: 'block' },
    ]);
  });

  test("'default' clears a whole group at once, and a path with no rule is a no-op", () => {
    expect(applyBulkPolicy([{ match: 'a', action: 'block' }], ['a', 'b', 'c'], 'default')).toEqual(
      [],
    );
  });

  test("'default' also clears a mis-cased rule", () => {
    expect(
      applyBulkPolicy([{ match: 'GetPetById', action: 'block' }], ['getpetbyid'], 'default'),
    ).toEqual([]);
  });
});

describe('isPatternRule', () => {
  test('the catch-all glob', () => {
    expect(isPatternRule('*')).toBe(true);
  });
  test('a prefix glob', () => {
    expect(isPatternRule('delete_*')).toBe(true);
  });
  test('a slash-wrapped regex', () => {
    expect(isPatternRule('/^delete/i')).toBe(true);
  });
  test('a regex with no flags', () => {
    expect(isPatternRule('/^delete/')).toBe(true);
  });
  test('a plain tool path is not a pattern', () => {
    expect(isPatternRule('send_email')).toBe(false);
  });
  test('a dotted tool path is not a pattern — the dot is literal here', () => {
    expect(isPatternRule('charges.create')).toBe(false);
  });
});

describe('orderPolicyRules', () => {
  // The runtime is first-match-wins (apps/api/src/connectors/policy.ts
  // `resolveEffectiveAction`), so a `*` rule sitting ahead of an exact rule
  // makes that exact rule dead. Exact rules must be sent first.
  test('exact rules are sent before pattern rules', () => {
    expect(
      orderPolicyRules([
        { match: '*', action: 'require_approval' },
        { match: 'send_email', action: 'block' },
      ]),
    ).toEqual([
      { match: 'send_email', action: 'block' },
      { match: '*', action: 'require_approval' },
    ]);
  });
  test('order within each class is preserved', () => {
    expect(
      orderPolicyRules([
        { match: 'b', action: 'block' },
        { match: 'x_*', action: 'block' },
        { match: 'a', action: 'always_run' },
        { match: '*', action: 'block' },
      ]),
    ).toEqual([
      { match: 'b', action: 'block' },
      { match: 'a', action: 'always_run' },
      { match: 'x_*', action: 'block' },
      { match: '*', action: 'block' },
    ]);
  });
  test('an all-exact list is unchanged', () => {
    const rules = [
      { match: 'a', action: 'block' } as const,
      { match: 'b', action: 'block' } as const,
    ];
    expect(orderPolicyRules(rules)).toEqual([...rules]);
  });
});

describe('toolChoice', () => {
  test('prefers the server-resolved entry, which knows the scope precedence', () => {
    expect(
      toolChoice(
        'send_email',
        [{ match: 'send_email', action: 'always_run' }],
        [eff('send_email', 'block', 'project')],
      ),
    ).toBe('block');
  });
  test('falls back to the stored rule when the server sent no effective list', () => {
    // `effective` is [] for a manifest-only connector
    // (apps/api/src/connectors/db-deps.ts:1151) and on older servers.
    expect(toolChoice('send_email', [{ match: 'send_email', action: 'block' }], [])).toBe('block');
  });
  test('a pattern rule is not an exact rule, so the fallback stays default', () => {
    expect(toolChoice('send_email', [{ match: '*', action: 'block' }], [])).toBe('default');
  });
  test('nothing anywhere is default', () => {
    expect(toolChoice('send_email', [], [])).toBe('default');
  });
  test('the fallback matches case-insensitively, exactly as the engine does', () => {
    expect(toolChoice('getpetbyid', [{ match: 'GetPetById', action: 'block' }], [])).toBe('block');
  });
});

describe('previewEffective', () => {
  test('moves the named paths to the new action under connector scope', () => {
    expect(
      previewEffective(
        [eff('a', 'always_run', 'risk_default'), eff('b', 'always_run', 'allow_all')],
        ['a'],
        'block',
      ),
    ).toEqual([eff('a', 'block', 'connector'), eff('b', 'always_run', 'allow_all')]);
  });
  test('never overwrites a project-scope entry — the server would not either', () => {
    expect(previewEffective([eff('a', 'block', 'project')], ['a'], 'always_run')).toEqual([
      eff('a', 'block', 'project'),
    ]);
  });
  test('an empty effective list stays empty — nothing is invented', () => {
    expect(previewEffective([], ['a'], 'block')).toEqual([]);
  });
  // Returning the tool to default drops its resolved entry rather than
  // guessing one: what it falls back to (a glob, the risk default, allow_all)
  // is the engine's call, and `toolChoice` reads 'default' from the absence.
  test("'default' drops the entry rather than inventing the fallback action", () => {
    expect(
      previewEffective(
        [eff('a', 'block', 'connector'), eff('b', 'block', 'connector')],
        ['a'],
        'default',
      ),
    ).toEqual([eff('b', 'block', 'connector')]);
  });
  test("'default' still never touches a project-scope entry", () => {
    expect(previewEffective([eff('a', 'block', 'project')], ['a'], 'default')).toEqual([
      eff('a', 'block', 'project'),
    ]);
  });
});
