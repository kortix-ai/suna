/**
 * `goals:` validation — the gate that keeps `kortix validate` honest.
 *
 * The bug this suite pins down: the RUNTIME parser
 * (apps/api/src/projects/lib/agi-goals.ts) is safe in the wrong direction. It
 * DROPS a goal it cannot parse, so a goal missing `done_when` never becomes a
 * spec and never desugars a push trigger — it silently does not exist. With
 * nothing checking in this package, `kortix validate --json` answered
 * `{"valid":true,"issues":[]}` with exit 0 for exactly that manifest and
 * `kortix ship` pushed it: the author is told the goal is fine and then watches
 * nothing happen forever, with no error anywhere.
 *
 * So the load-bearing assertion in almost every test below is on `valid` — the
 * bit that decides whether a broken goal reaches a branch.
 */
import { describe, expect, test } from 'bun:test';
import { GOAL_DONE_WHEN_MIN_LENGTH } from '../constants.ts';
import { validateManifest } from '../index.ts';

/** A v2 YAML manifest whose `goals:` block is `body`. v2 requires
 *  default_agent + agents, so every fixture carries the same minimal pair and
 *  any issue that surfaces is the goals block's. */
function manifest(body: string) {
  return ['kortix_version: 2', 'default_agent: main', 'agents:', '  main: {}', 'goals:', body].join(
    '\n',
  );
}

function check(body: string) {
  const result = validateManifest(manifest(body), 'yaml');
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  return { ...result, errors, warnings, errorPaths: errors.map((i) => i.path) };
}

const GOOD_DONE_WHEN = 'A live account runs the strategy unattended for 7 days.';

describe('R-7 — a goal without done_when is invalid, not merely inert', () => {
  test('the exact manifest that used to validate clean now fails', () => {
    const { valid, errors } = check('  - slug: oil-desk\n    title: Oil trades running 24/7');
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('goals[0].done_when');
    // The message has to name the consequence, because the author's evidence is
    // that everything "worked": the goal just never did anything.
    expect(errors[0].message).toContain('done_when');
    expect(errors[0].message).toContain('silently');
  });

  test('an empty or whitespace-only done_when is the same error, not a blank field', () => {
    expect(check(`  - slug: a\n    done_when: ""`).valid).toBe(false);
    expect(check(`  - slug: a\n    done_when: "   "`).valid).toBe(false);
  });

  test('a non-string done_when does not satisfy R-7', () => {
    expect(check('  - slug: a\n    done_when: 42').errorPaths).toContain('goals[0].done_when');
  });

  test('the `doneWhen` alias the runtime parser accepts is accepted here too', () => {
    // A gate stricter than the runtime falsely blocks a manifest that works.
    expect(check(`  - slug: a\n    doneWhen: ${GOOD_DONE_WHEN}`).valid).toBe(true);
  });

  test('a well-formed goal still validates', () => {
    const { valid, issues } = check(
      `  - slug: oil-desk\n    title: Oil trades running 24/7\n    done_when: ${GOOD_DONE_WHEN}\n    status: active\n    push: "0 0 9 * * *"\n    agent: kortix-agi\n    metric: pnl_usd`,
    );
    expect(valid).toBe(true);
    expect(issues).toEqual([]);
  });

  test('a manifest with no goals block at all is untouched', () => {
    const result = validateManifest(
      'kortix_version: 2\ndefault_agent: main\nagents:\n  main: {}\n',
      'yaml',
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('goals — shape', () => {
  test('a `goals` map or scalar is rejected with a YAML-shaped hint', () => {
    const result = validateManifest(
      'kortix_version: 2\ndefault_agent: main\nagents:\n  main: {}\ngoals:\n  oil-desk: {}\n',
      'yaml',
    );
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.path === 'goals');
    expect(issue?.message).toContain('list');
    // A YAML author must never be told to write `[[goals]]`.
    expect(issue?.message).not.toContain('[[goals]]');
  });

  test('an entry that is not a table is rejected', () => {
    expect(check('  - just-a-string').errorPaths).toEqual(['goals[0]']);
  });

  test('slug is required, validated, and unique', () => {
    expect(check(`  - done_when: ${GOOD_DONE_WHEN}`).errorPaths).toContain('goals[0].slug');
    expect(check(`  - slug: Oil Desk\n    done_when: ${GOOD_DONE_WHEN}`).errorPaths).toContain(
      'goals[0].slug',
    );
    const dupe = check(
      `  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n  - slug: a\n    done_when: ${GOOD_DONE_WHEN}`,
    );
    // The SECOND declaration is the error — the first one is the goal that
    // actually exists.
    expect(dupe.errorPaths).toEqual(['goals[1].slug']);
  });

  test('status must be one of the four authored states', () => {
    expect(
      check(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    status: done`).errorPaths,
    ).toContain('goals[0].status');
    for (const status of ['active', 'achieved', 'paused', 'abandoned']) {
      expect(
        check(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    status: ${status}`).valid,
      ).toBe(true);
    }
  });
});

describe('goals — push is sugar for one cron trigger (R-8), so it is held to cron rules', () => {
  test('a push croner cannot parse is rejected, not deferred to a fire that never happens', () => {
    const { valid, errorPaths } = check(
      `  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    push: "not a cron"`,
    );
    expect(valid).toBe(false);
    expect(errorPaths).toContain('goals[0].push');
  });

  test('an empty push is rejected — omit it for an on-demand goal', () => {
    expect(
      check(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    push: ""`).errorPaths,
    ).toContain('goals[0].push');
  });

  test('a bad IANA timezone is rejected — the runtime swallows it and the push never fires', () => {
    const { errorPaths } = check(
      `  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    push: "0 0 9 * * *"\n    timezone: PST`,
    );
    expect(errorPaths).toContain('goals[0].timezone');
  });

  test('a valid IANA timezone passes', () => {
    expect(
      check(
        `  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    push: "0 0 9 * * *"\n    timezone: America/New_York`,
      ).valid,
    ).toBe(true);
  });
});

describe('goals — R-12e `metric` declares the series that IS the verdict', () => {
  test('a near-miss key is a hard error, because the declaration would be silently dropped', () => {
    const { valid, errors } = check(
      `  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    primary_metric: pnl_usd`,
    );
    expect(valid).toBe(false);
    expect(errors[0].path).toBe('goals[0].primary_metric');
    expect(errors[0].message).toContain('ANY flat metric');
  });

  test('the runtime folds case and whitespace, so the gate must accept what it accepts', () => {
    // `metric: Core Position` is a legal declaration of `core_position`.
    expect(
      check(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    metric: Core Position`).valid,
    ).toBe(true);
  });

  test('a charset the observations wire rejects is rejected here', () => {
    expect(
      check(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}\n    metric: impressions/day`)
        .errorPaths,
    ).toContain('goals[0].metric');
  });
});

describe('the YAML `#` footgun surfaces in `kortix validate`', () => {
  test('a truncated done_when is warned about, and does NOT block the push', () => {
    // YAML already ate the value: `rank #1 sustained 30 days` reaches the
    // validator as `rank`. Only the fingerprint (a done_when far too short to
    // evaluate) survives, which is what this warns on.
    const { valid, warnings, parsed } = check(
      '  - slug: seo\n    done_when: rank #1 sustained 30 days',
    );
    expect((parsed as { goals: Array<{ done_when: string }> }).goals[0].done_when).toBe('rank');
    // Advisory, never fatal: the runtime still parses and still pushes this goal.
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe('goals[0].done_when');
    // The direction of the silent failure is the point worth stating.
    expect(warnings[0].message).toContain('UNQUANTIFIED');
  });

  test('a SURVIVING "#" is warned about too — it is one unquoting edit from vanishing', () => {
    const { valid, warnings } = check(
      `  - slug: seo\n    title: "platinum.dev ranks #1 on Google"\n    done_when: "Ranked #1 for the core terms for 30 consecutive days."`,
    );
    expect(valid).toBe(true);
    expect(warnings.map((w) => w.path).sort()).toEqual(['goals[0].done_when', 'goals[0].title']);
  });

  test('prose at or over the minimum length is not warned about', () => {
    const long = 'x'.repeat(GOAL_DONE_WHEN_MIN_LENGTH);
    expect(check(`  - slug: a\n    done_when: ${long}`).warnings).toEqual([]);
    expect(check(`  - slug: a\n    done_when: ${'x'.repeat(19)}`).warnings).toHaveLength(1);
  });

  test('a MISSING done_when produces the R-7 error alone, not a redundant length warning', () => {
    // Two complaints about one field is how a real error gets skimmed past.
    const { errors, warnings } = check('  - slug: a');
    expect(errors).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe('goals validate identically under v1 and v2', () => {
  const v1 = (goalBody: string) =>
    validateManifest(`kortix_version: 1\ngoals:\n${goalBody}\n`, 'yaml');

  test('v1 YAML enforces done_when exactly as v2 does', () => {
    expect(v1('  - slug: a').valid).toBe(false);
    expect(v1(`  - slug: a\n    done_when: ${GOOD_DONE_WHEN}`).valid).toBe(true);
  });

  test('v1 TOML `[[goals]]` gets the TOML-shaped list hint', () => {
    const result = validateManifest('kortix_version = 1\n[goals]\nslug = "a"\n', 'toml');
    expect(result.valid).toBe(false);
    expect(result.issues.find((i) => i.path === 'goals')?.message).toContain('[[goals]]');
  });
});
