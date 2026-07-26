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
import { AGI_AGENT_NAME, agiAgentGrant, grantFromLoadedAgents } from '../agents';
import {
  MANIFEST_FILENAME_YAML,
  extractTriggers,
  parseManifestString,
  serializeManifest,
} from '../triggers';
import {
  desugarGoalTriggers,
  extractGoals,
  goalPushPrompt,
  goalTriggerSlug,
  isGoalTriggerSlug,
} from './agi-goals';
import { goalTriggersEnabled } from './triggers';

const parse = (yaml: string) => parseManifestString(yaml, 'yaml', MANIFEST_FILENAME_YAML);

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
    expect(errors.map((e) => e.slug)).toEqual(['bad']);
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
    expect(errors[0].error).toContain('Duplicate goal slug');
  });

  test('a goals block that is not a list is one clear top-level error', () => {
    const { specs, errors } = extractGoals(parse('kortix_version: 2\ngoals:\n  oil: yes\n'));
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].slug).toBe('(top-level)');
    expect(errors[0].error).toContain('must be a list');
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
