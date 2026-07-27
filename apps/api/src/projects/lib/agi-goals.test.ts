/**
 * Goals as a kortix.yaml block — docs/specs/2026-07-26-agi-autonomous-operations.md §4.
 *
 * The four things that must hold, and are easy to silently break:
 *   R-6  round-trip fidelity — the web UI does read-modify-write on this same
 *        file, so a `goals:` block must survive parse → edit → serialize with
 *        zero data loss, including keys this parser never reads.
 *   R-7  `done_when` is mandatory and the rejection message says why.
 *   R-8  `push` desugars to EXACTLY ONE cron trigger in the existing trigger
 *        subsystem, with a slug that is a pure function of the goal slug.
 *   R-8  re-ship idempotency — re-reading (or re-serializing and re-reading) a
 *        manifest yields the same one trigger, never an accumulating pile.
 *
 * Pure parser, no I/O: everything runs off `parseManifestString`.
 */
import { describe, expect, test } from 'bun:test';
import {
  GOAL_DONE_WHEN_MIN_LENGTH as GATE_GOAL_DONE_WHEN_MIN_LENGTH,
  GOAL_METRIC_NEAR_MISS_KEYS as GATE_GOAL_METRIC_NEAR_MISS_KEYS,
  GOAL_STATUSES as GATE_GOAL_STATUSES,
  validateManifest,
} from '@kortix/manifest-schema';
import { AGI_AGENT_NAME, agiAgentGrant, grantFromLoadedAgents } from '../agents';
import {
  MANIFEST_FILENAME_YAML,
  extractTriggers,
  parseManifestString,
  serializeManifest,
} from '../triggers';
import {
  GOAL_DONE_WHEN_MIN_LENGTH,
  GOAL_STATUSES,
  desugarGoalTriggers,
  extractGoals,
  goalPushPrompt,
  goalTriggerSlug,
  isGoalTriggerSlug,
  isGoalWarning,
} from './agi-goals';
import { goalTriggersEnabled } from './triggers';

const parse = (yaml: string) => parseManifestString(yaml, 'yaml', MANIFEST_FILENAME_YAML);

/** Errors that REJECTED a goal, as opposed to advisories on one that parsed.
 *  Both ride the same list on purpose (one channel a surface can forget to
 *  render); tests about rejection say which half they mean. */
const fatal = <T extends { error: string }>(errors: readonly T[]) =>
  errors.filter((error) => !isGoalWarning(error));

const warningsOnly = <T extends { error: string }>(errors: readonly T[]) =>
  errors.filter((error) => isGoalWarning(error));

const MANIFEST = `kortix_version: 2

project:
  name: acme

goals:
  - slug: oil-desk
    title: Oil trades running 24/7
    done_when: >
      A live account executes the strategy unattended for 7 consecutive days
      with no manual intervention and a positive risk-adjusted return.
    status: active
    push: "0 0 9 * * *"
    agent: trader

  - slug: hire-ops
    title: Ops lead hired
    done_when: An offer is signed and a start date is on the calendar.
    status: paused

triggers:
  - slug: daily-digest
    type: cron
    agent: default
    cron: "0 0 8 * * *"
    prompt: "Generate the daily digest"
`;

describe('extractGoals', () => {
  test('parses a goals block in declaration order with defaults applied', () => {
    const { specs, errors } = extractGoals(parse(MANIFEST));

    expect(errors).toEqual([]);
    expect(specs.map((g) => g.slug)).toEqual(['oil-desk', 'hire-ops']);

    const [oil, hire] = specs;
    expect(oil.title).toBe('Oil trades running 24/7');
    expect(oil.doneWhen).toContain('7 consecutive days');
    expect(oil.status).toBe('active');
    expect(oil.push).toBe('0 0 9 * * *');
    expect(oil.agent).toBe('trader');
    expect(oil.timezone).toBe('UTC');
    expect(oil.triggerSlug).toBe('goal-oil-desk');
    expect(oil.path).toBe('kortix.yaml#goals.oil-desk');

    // Defaults: no agent, no push, no timezone declared. An unqualified goal is
    // advanced by the platform AGI (R-38) — the push prompt IS its loop.
    expect(hire.agent).toBe(AGI_AGENT_NAME);
    expect(hire.push).toBeNull();
    expect(hire.triggerSlug).toBeNull();
    expect(hire.status).toBe('paused');
  });

  test('a manifest with no goals block yields no goals and no errors', () => {
    const { specs, errors } = extractGoals(parse('kortix_version: 2\n'));
    expect(specs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('R-7: a goal without done_when is rejected with a message that says why', () => {
    const { specs, errors } = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: vibes\n    title: Be great\n'),
    );

    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].slug).toBe('vibes');
    expect(errors[0].error).toContain('done_when');
    expect(errors[0].error).toContain('wish');
  });

  test('R-7: a blank done_when is rejected the same as an absent one', () => {
    const { errors } = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: vibes\n    done_when: "   "\n'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('done_when');
  });

  test('one malformed goal does not blank the rest of the list', () => {
    const { specs, errors } = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: bad\n  - slug: good\n    done_when: It ships.\n'),
    );
    expect(specs.map((g) => g.slug)).toEqual(['good']);
    expect(fatal(errors).map((e) => e.slug)).toEqual(['bad']);
  });

  test('rejects an unknown status, a bad slug, a bad timezone, and a non-string push', () => {
    const status = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: g\n    done_when: x\n    status: shipped\n'),
    );
    expect(status.errors[0].error).toContain('status must be one of');

    const slug = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: "Oil Desk"\n    done_when: x\n'),
    );
    expect(slug.errors[0].error).toContain('Invalid slug');

    const tz = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: g\n    done_when: x\n    timezone: PST\n'),
    );
    expect(tz.errors[0].error).toContain('valid IANA name');

    const push = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: g\n    done_when: x\n    push: 5\n'),
    );
    expect(push.errors[0].error).toContain('cron expression string');
  });

  test('a duplicate slug keeps the first goal and reports the second', () => {
    const { specs, errors } = extractGoals(
      parse(
        'kortix_version: 2\ngoals:\n  - slug: g\n    title: First\n    done_when: x\n  - slug: g\n    title: Second\n    done_when: y\n',
      ),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].title).toBe('First');
    expect(fatal(errors)[0].error).toContain('Duplicate goal slug');
    // The SECOND declaration is the offending one — index 0 parsed cleanly.
    expect(fatal(errors)[0].index).toBe(1);
  });

  // The ordinal is the only handle a malformed entry has: three of the four
  // rejection shapes below produce no usable slug, so "goal #N" is the whole
  // address. Carried from the parser rather than reconstructed downstream.
  test('every error carries the ordinal of the entry it came from', () => {
    const { errors } = extractGoals(
      parse(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
  - title: nameless
    done_when: Done.
  - just-a-string
  - slug: broken
    title: No criteria
`),
    );

    expect(fatal(errors).map((e) => e.index)).toEqual([1, 2, 3]);
    expect(fatal(errors).map((e) => e.slug)).toEqual(['(index-1)', '(invalid)', 'broken']);
  });

  test('a block-level error has no entry to point at and says so with -1', () => {
    const { errors } = extractGoals(parse('kortix_version: 2\ngoals:\n  oil: yes\n'));
    expect(errors[0].index).toBe(-1);
  });

  test('a goals block that is not a list is one clear top-level error', () => {
    const { specs, errors } = extractGoals(parse('kortix_version: 2\ngoals:\n  oil: yes\n'));
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].slug).toBe('(top-level)');
    expect(errors[0].error).toContain('must be a list');
  });
});

// R-12e. `done_when` is prose and names no metric, so without a declaration
// nothing associates a threshold with a series — and a goal tracking three
// numbers can have the one that matters sit dead for weeks behind the noise.
describe('`metric:` — the series that defines the goal', () => {
  const goal = (body: string) =>
    extractGoals(parse(`kortix_version: 2\ngoals:\n  - slug: seo\n${body}`));

  test('an absent declaration is null, and every existing goal keeps working', () => {
    const { specs, errors } = extractGoals(parse(MANIFEST));
    expect(fatal(errors)).toEqual([]);
    expect(specs.map((g) => g.primaryMetric)).toEqual([null, null]);
  });

  test('a declaration is normalized exactly as a recorded observation is', () => {
    // Both sides go through normalizeMetric, so the declared name compares by
    // `===` against what `kortix goals observe --metric` writes. A looser rule
    // here would let `Core Position` name a primary `core_position` can never
    // satisfy, and the goal would sit unmeasurable for a reason nobody can see.
    const { specs, errors } = goal(
      '    done_when: Top 3 for the core terms, sustained 30 days.\n    metric: "GSC Avg Position Core"\n',
    );
    expect(fatal(errors)).toEqual([]);
    expect(specs[0].primaryMetric).toBe('gsc_avg_position_core');
  });

  test('a malformed metric is FATAL, never a silently dropped declaration', () => {
    // The alternative is a declaration that looks honoured and is not, which is
    // the exact class of bug this field exists to close.
    const { specs, errors } = goal('    done_when: Top 3 for the core terms.\n    metric: a/b\n');
    expect(specs).toEqual([]);
    expect(fatal(errors)[0].error).toContain('defines this goal');
  });

  test('a near-miss key is rejected by name rather than ignored', () => {
    for (const key of ['primary_metric', 'primaryMetric', 'primary', 'metrics', 'metric_name']) {
      const { specs, errors } = goal(
        `    done_when: Top 3 for the core terms.\n    ${key}: rank\n`,
      );
      expect(specs).toEqual([]);
      expect(fatal(errors)[0].error).toContain('`metric:`');
      // Says what the silent consequence would have been, so the fix is obvious.
      expect(fatal(errors)[0].error).toContain('ANY flat metric');
    }
  });

  test('the push prompt names the declared metric, so the session records THAT one', () => {
    // A verdict computed from one series and a push told to record "whatever the
    // criteria measure" is a goal that reads unmeasurable forever while the
    // session dutifully records three other numbers.
    const { specs } = goal(
      '    done_when: Top 3 for the core terms.\n    metric: gsc_avg_position_core\n',
    );
    const prompt = goalPushPrompt(specs[0]);
    expect(prompt).toContain('--metric gsc_avg_position_core');
    expect(prompt).toContain('UNMEASURABLE');
  });

  test('an undeclared goal keeps the original "use the SAME metric name" prompt', () => {
    const { specs } = goal('    done_when: Top 3 for the core terms.\n');
    expect(goalPushPrompt(specs[0])).toContain('--metric <name>');
  });
});

// The YAML `#` footgun, confirmed live and completely silent: an unquoted `#`
// starts a comment, so the value is truncated before this parser ever sees it
// and `errors` comes back empty.
describe('the `#` footgun and its fingerprint', () => {
  const goal = (body: string) =>
    extractGoals(parse(`kortix_version: 2\ngoals:\n  - slug: seo\n${body}`));

  test('the truncation itself is invisible — which is why the fingerprint is warned on', () => {
    const { specs, errors } = goal('    title: ranks #1 on Google\n    done_when: rank #1 fast\n');
    // Proof of the hazard: YAML already ate both values, and the parser has
    // nothing left to detect at the point of failure.
    expect(specs[0].title).toBe('ranks');
    expect(specs[0].doneWhen).toBe('rank');
    expect(fatal(errors)).toEqual([]);
    // The fingerprint of an already-truncated `done_when` is that it is far too
    // short to be criteria a session could evaluate.
    expect(warningsOnly(errors)).toHaveLength(1);
    expect(warningsOnly(errors)[0].error).toContain('done_when');
    expect(warningsOnly(errors)[0].error).toContain('UNQUANTIFIED');
  });

  test('a truncated done_when is exactly the silent UNMEASURABLE → UNQUANTIFIED downgrade', () => {
    // "be number one #1 on google" truncates to "be number one": no digit and no
    // comparison word, so R-12d flips from "nobody is measuring this" to "there
    // is nothing to measure, that's fine" — the worst direction for a silent
    // failure, because the second reads as a deliberate choice.
    const { specs, errors } = goal('    done_when: be number one #1 on google\n');
    expect(specs[0].doneWhen).toBe('be number one');
    expect(warningsOnly(errors)).toHaveLength(1);
  });

  test('a surviving "#" is warned about too — it is one unquoted edit from vanishing', () => {
    const { specs, errors } = goal(
      '    title: "ranks #1 on Google"\n    done_when: "Ranked #1 for the core terms for 30 days."\n',
    );
    expect(specs).toHaveLength(1);
    const messages = warningsOnly(errors).map((e) => e.error);
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.includes('`title`'))).toBe(true);
    expect(messages.some((m) => m.includes('`done_when`'))).toBe(true);
  });

  test('a warned goal still parses, still pushes, and is addressable by slug and ordinal', () => {
    const { specs, errors } = goal('    done_when: Signed.\n    push: "0 0 9 * * *"\n');
    expect(specs[0].triggerSlug).toBe('goal-seo');
    expect(warningsOnly(errors)[0]).toMatchObject({
      index: 0,
      slug: 'seo',
      path: 'kortix.yaml#goals.seo',
    });
  });

  test('prose at or over the minimum length is not warned about', () => {
    const doneWhen = 'x'.repeat(GOAL_DONE_WHEN_MIN_LENGTH);
    expect(warningsOnly(goal(`    done_when: ${doneWhen}\n`).errors)).toEqual([]);
    expect(warningsOnly(goal(`    done_when: ${'x'.repeat(19)}\n`).errors)).toHaveLength(1);
  });

  test('warnings never reach the TRIGGER list — the derived trigger is fine', () => {
    // A permanent complaint next to a working trigger is how a list of real
    // problems stops being read.
    const manifest = parse(
      'kortix_version: 2\ngoals:\n  - slug: seo\n    done_when: Signed.\n    push: "0 0 9 * * *"\n',
    );
    const { specs, errors } = desugarGoalTriggers(manifest);
    expect(specs.map((s) => s.slug)).toEqual(['goal-seo']);
    expect(errors).toEqual([]);
  });

  test('a FATAL goal error still reaches the trigger list', () => {
    const { errors } = desugarGoalTriggers(
      parse('kortix_version: 2\ngoals:\n  - slug: seo\n    title: No criteria\n'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('done_when');
  });
});

describe('R-8 — push desugars to exactly one cron trigger', () => {
  test('the derived slug is a pure function of the goal slug', () => {
    expect(goalTriggerSlug('oil-desk')).toBe('goal-oil-desk');
    expect(goalTriggerSlug('oil-desk')).toBe(goalTriggerSlug('oil-desk'));
    expect(isGoalTriggerSlug('goal-oil-desk')).toBe(true);
    expect(isGoalTriggerSlug('daily-digest')).toBe(false);
  });

  test('one pushing goal yields exactly one enabled cron trigger targeting its agent', () => {
    const { specs, errors } = desugarGoalTriggers(parse(MANIFEST));

    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    const [trigger] = specs;
    expect(trigger.slug).toBe('goal-oil-desk');
    expect(trigger.type).toBe('cron');
    expect(trigger.cron).toBe('0 0 9 * * *');
    expect(trigger.runAt).toBeNull();
    expect(trigger.agent).toBe('trader');
    expect(trigger.enabled).toBe(true);
    expect(trigger.timezone).toBe('UTC');
    expect(trigger.path).toBe('kortix.yaml#goals.oil-desk');
    expect(trigger.promptTemplate).toContain('oil-desk');
    expect(trigger.promptTemplate).toContain('7 consecutive days');
  });

  test('a goal without push contributes no trigger', () => {
    const { specs } = desugarGoalTriggers(
      parse('kortix_version: 2\ngoals:\n  - slug: hire\n    done_when: Offer signed.\n'),
    );
    expect(specs).toEqual([]);
  });

  test('a non-active goal still yields its trigger, disabled', () => {
    const { specs } = desugarGoalTriggers(
      parse(
        'kortix_version: 2\ngoals:\n  - slug: g\n    done_when: x\n    status: paused\n    push: "0 0 9 * * *"\n',
      ),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].enabled).toBe(false);
  });

  test('R-9: the push prompt forbids the session marking the goal achieved', () => {
    const prompt = goalPushPrompt({ slug: 'g', title: 'G', doneWhen: 'x' });
    expect(prompt).toContain('Do not mark the goal achieved');
    expect(goalPushPrompt({ slug: 'g', title: 'G', doneWhen: 'x' })).toBe(prompt);
  });

  // Without this the verb exists and nothing calls it, which is exactly the
  // failure spec section 4.2 describes: "measurably advanced" stays an adjective
  // in a prompt string and the model grades its own homework.
  test('R-12: the push prompt makes taking a reading part of the push', () => {
    const prompt = goalPushPrompt({ slug: 'seo', title: 'SEO', doneWhen: 'Top 3.' });
    expect(prompt).toContain('kortix goals observe seo --metric <name> --value <number>');
    expect(prompt).toContain('TAKE A READING');
    // R-12a: the push IS the signal. It must not send the session off to build a
    // scheduler of its own.
    expect(prompt).not.toContain('cron');
    // R-12d and R-12f, in the session's own instructions.
    expect(prompt).toContain('UNMEASURABLE');
    expect(prompt).toContain('recording one never changes the status');
  });

  test('a goal that names no agent desugars to a trigger targeting the platform AGI', () => {
    const { specs } = desugarGoalTriggers(
      parse(
        'kortix_version: 2\ngoals:\n  - slug: oil\n    done_when: x\n    push: "0 0 9 * * *"\n',
      ),
    );
    expect(specs[0].agent).toBe(AGI_AGENT_NAME);
  });

  test('the AGI-targeted trigger resolves to a real grant, not the deny-all an unlisted name gets', () => {
    // The defect this closes: a trigger targets an agent BY NAME, and a governed
    // project denies every name it did not declare. A goal push that resolved
    // that way booted with `kortixCli: []` and 403'd on every `kortix` call, so
    // the scheduled push structurally could not run the AGI.
    const { specs } = desugarGoalTriggers(
      parse(
        'kortix_version: 2\ngoals:\n  - slug: oil\n    done_when: x\n    push: "0 0 9 * * *"\n',
      ),
    );
    const governed = {
      specs: [
        {
          name: 'release-bot',
          path: 'kortix.yaml#agents.release-bot',
          enabled: true,
          connectors: [] as string[],
          kortixCli: [] as string[],
          env: [] as string[],
          file: null,
          model: null,
        },
      ],
      errors: [],
      defaultAgent: null,
    };

    expect(grantFromLoadedAgents(specs[0].agent, governed)).toEqual(agiAgentGrant());
  });

  test('a goal naming a project agent still targets that agent', () => {
    const { specs } = desugarGoalTriggers(parse(MANIFEST));
    expect(specs[0].agent).toBe('trader');
  });

  test('a collision with an authored trigger drops the derived one and reports it', () => {
    const manifest = parse(
      'kortix_version: 2\ngoals:\n  - slug: oil\n    done_when: x\n    push: "0 0 9 * * *"\ntriggers:\n  - slug: goal-oil\n    type: cron\n    cron: "0 0 1 * * *"\n    prompt: mine\n',
    );
    const { specs, errors } = desugarGoalTriggers(manifest, new Set(['goal-oil']));
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].slug).toBe('goal-oil');
    expect(errors[0].error).toContain('already declared in `triggers`');
  });

  // The defect this closes: a goal that fails to parse has no derived trigger,
  // so dropping its parse error made it invisible here — the goals route
  // reported the broken goal and the trigger list showed neither an entry nor a
  // complaint.
  test('a goal that fails to parse is reported, not silently absent', () => {
    const { specs, errors } = desugarGoalTriggers(
      parse(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
    push: "0 0 9 * * *"
  - slug: broken
    title: No criteria
  - slug: fine
    done_when: Also done.
`),
    );

    expect(specs.map((s) => s.slug)).toEqual(['goal-fine']);
    expect(errors.map((e) => e.slug)).toEqual(['broken', 'fine']);
    expect(errors[0].error).toContain('done_when');
    expect(errors[1].error).toContain('Duplicate goal slug');
    // The path is what tells a reader looking at TRIGGERS that the complaint
    // came out of the goals block.
    expect(errors[0].path).toBe('kortix.yaml#goals.broken');
  });

  test('a goals block that is not a list surfaces as a trigger-list error too', () => {
    const { specs, errors } = desugarGoalTriggers(parse('kortix_version: 2\ngoals:\n  oil: yes\n'));
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('must be a list');
  });
});

describe('extractTriggers — goal desugaring is opt-in (the `agi` gate)', () => {
  test('goal triggers are absent by default and present when opted in', () => {
    const manifest = parse(MANIFEST);

    const off = extractTriggers(manifest);
    expect(off.specs.map((s) => s.slug)).toEqual(['daily-digest']);

    const on = extractTriggers(manifest, { goals: true });
    expect(on.specs.map((s) => s.slug)).toEqual(['daily-digest', 'goal-oil-desk']);
  });

  test('an authored trigger of the same slug wins and the collision surfaces as an error', () => {
    const manifest = parse(
      'kortix_version: 2\ngoals:\n  - slug: oil\n    done_when: x\n    push: "0 0 9 * * *"\ntriggers:\n  - slug: goal-oil\n    type: cron\n    cron: "0 0 1 * * *"\n    prompt: mine\n',
    );
    const { specs, errors } = extractTriggers(manifest, { goals: true });
    expect(specs).toHaveLength(1);
    expect(specs[0].promptTemplate).toBe('mine');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('already declared in `triggers`');
  });

  test('a malformed triggers block still reports, and goals still desugar alongside it', () => {
    const manifest = parse(
      'kortix_version: 2\ntriggers:\n  daily: yes\ngoals:\n  - slug: oil\n    done_when: x\n    push: "0 0 9 * * *"\n',
    );
    const { specs, errors } = extractTriggers(manifest, { goals: true });
    expect(specs.map((s) => s.slug)).toEqual(['goal-oil']);
    expect(errors.map((e) => e.slug)).toEqual(['(top-level)']);
  });

  test('a broken goal reaches the trigger list as an error, and only when opted in', () => {
    const manifest = parse('kortix_version: 2\ngoals:\n  - slug: broken\n    title: No criteria\n');

    // With `agi` off a project behaves exactly as it did before goals existed —
    // including reporting nothing about a `goals:` block it does not read.
    expect(extractTriggers(manifest).errors).toEqual([]);

    const { errors } = extractTriggers(manifest, { goals: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].slug).toBe('broken');
    expect(errors[0].error).toContain('done_when');
  });

  // The option above is inert until a caller opts in. `goalTriggersEnabled` is
  // the single decision the sweep, the listing and the manual fire all share —
  // R-8 is only live because it answers true for an agi project.
  test('goalTriggersEnabled reads the `agi` experimental key off project metadata', () => {
    expect(goalTriggersEnabled({ experimental: { agi: true } })).toBe(true);
    expect(goalTriggersEnabled({ experimental: { agi: false } })).toBe(false);
    // platformDefault is false (R-44), so absent metadata means no goal triggers
    expect(goalTriggersEnabled({})).toBe(false);
    expect(goalTriggersEnabled(null)).toBe(false);
    expect(goalTriggersEnabled(undefined)).toBe(false);
    expect(goalTriggersEnabled({ experimental: { other_flag: true } })).toBe(false);
  });

  test('the predicate is what decides whether a goal contributes a trigger', () => {
    const manifest = parse(MANIFEST);
    for (const metadata of [{ experimental: { agi: true } }, {}]) {
      const enabled = goalTriggersEnabled(metadata);
      const { specs } = extractTriggers(manifest, { goals: enabled });
      expect(specs.some((s) => s.slug === 'goal-oil-desk')).toBe(enabled);
    }
  });
});

describe('R-6 — round-trip fidelity through the read-modify-write path', () => {
  test('serialize → re-parse preserves every goal field, including ones this parser ignores', () => {
    // `owner`/`tags` are keys the goal parser knows nothing about — a manifest
    // written for a newer platform, or a human's own annotation. They must ride
    // through the round trip untouched.
    const manifest = parse(
      'kortix_version: 2\ngoals:\n  - slug: oil-desk\n    title: Oil\n    done_when: It runs.\n    owner: marko\n    tags:\n      - trading\n      - overnight\n',
    );
    const before = structuredClone(manifest.raw.goals);

    const reparsed = parse(serializeManifest(manifest));

    expect(reparsed.raw.goals).toEqual(before);
  });

  test('a shallow-spread edit of another block (the web-UI write shape) leaves goals untouched', () => {
    const manifest = parse(MANIFEST);
    const goalsBefore = structuredClone(manifest.raw.goals);

    // Exactly what upsertTriggerInManifest does: replace ONE top-level key by
    // spreading `raw`. If a write path ever rebuilds `raw` from an allowlist
    // instead, this is the test that catches the silently-dropped goals block.
    const edited = {
      ...manifest,
      raw: {
        ...manifest.raw,
        triggers: [
          ...(manifest.raw.triggers as unknown[]),
          { slug: 'new-one', type: 'cron', cron: '0 0 7 * * *', prompt: 'hi' },
        ],
      },
    };

    const reparsed = parse(serializeManifest(edited));

    expect(reparsed.raw.goals).toEqual(goalsBefore);
    expect(extractGoals(reparsed).specs.map((g) => g.slug)).toEqual(['oil-desk', 'hire-ops']);
    expect(extractTriggers(reparsed, { goals: true }).specs.map((s) => s.slug)).toEqual([
      'daily-digest',
      'goal-oil-desk',
      'new-one',
    ]);
  });

  test('re-ship idempotency: repeated serialize → parse cycles never accumulate triggers', () => {
    let manifest = parse(MANIFEST);
    const first = extractTriggers(manifest, { goals: true }).specs;

    for (let i = 0; i < 3; i++) {
      manifest = parse(serializeManifest(manifest));
    }

    const after = extractTriggers(manifest, { goals: true }).specs;
    expect(after).toEqual(first);
    expect(after.filter((s) => isGoalTriggerSlug(s.slug))).toHaveLength(1);
    // The derived trigger is never written into the file — that is WHY it
    // cannot accumulate. Guard the mechanism, not just the symptom.
    expect(
      (manifest.raw.triggers as Array<{ slug: string }>).some((t) => isGoalTriggerSlug(t.slug)),
    ).toBe(false);
  });
});

/**
 * The pre-flight gate (`kortix validate` / the CR-merge backstop) is a SECOND,
 * independent implementation of these rules, in `@kortix/manifest-schema` —
 * that package cannot import apps/api, so nothing but this block stops the two
 * from drifting.
 *
 * Drift here is silent and one-directional in the worst way: this parser DROPS
 * a goal it cannot parse, so a rule the gate stops enforcing produces a manifest
 * that validates clean, ships, and contains a goal that does not exist.
 */
describe('drift guard — the manifest gate enforces exactly what this parser does', () => {
  const gate = (goalsBlock: string) =>
    validateManifest(
      `kortix_version: 2\ndefault_agent: main\nagents:\n  main: {}\ngoals:\n${goalsBlock}`,
      'yaml',
    );

  test('the status vocabulary is the same list on both sides', () => {
    expect([...GATE_GOAL_STATUSES]).toEqual([...GOAL_STATUSES]);
  });

  test('the done_when advisory threshold is the same number on both sides', () => {
    expect(GATE_GOAL_DONE_WHEN_MIN_LENGTH).toBe(GOAL_DONE_WHEN_MIN_LENGTH);
  });

  test('every near-miss metric key the gate forbids is one this parser also rejects', () => {
    for (const key of GATE_GOAL_METRIC_NEAR_MISS_KEYS) {
      const yaml = `  - slug: a\n    done_when: A live account runs unattended for 7 days.\n    ${key}: pnl_usd`;
      expect(gate(yaml).valid).toBe(false);
      const { errors } = extractGoals(parse(`kortix_version: 2\ngoals:\n${yaml}`));
      expect(fatal(errors)).toHaveLength(1);
    }
  });

  test('R-7: a goal this parser drops is a goal the gate REFUSES to ship', () => {
    // The regression itself. Before the gate knew about goals, this manifest
    // came back `{"valid":true,"issues":[]}` with exit 0 while the goal below
    // silently did not exist.
    const yaml = '  - slug: oil-desk\n    title: Oil trades running 24/7';
    expect(extractGoals(parse(`kortix_version: 2\ngoals:\n${yaml}`)).specs).toEqual([]);
    expect(gate(yaml).valid).toBe(false);
  });

  test('a goal this parser accepts is one the gate ships without complaint', () => {
    const yaml =
      '  - slug: oil-desk\n    done_when: A live account runs the strategy unattended for 7 days.\n    push: "0 0 9 * * *"\n    metric: pnl_usd';
    const { specs, errors } = extractGoals(parse(`kortix_version: 2\ngoals:\n${yaml}`));
    expect(specs).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(gate(yaml).issues).toEqual([]);
  });
});
