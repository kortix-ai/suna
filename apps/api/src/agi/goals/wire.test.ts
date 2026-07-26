/**
 * The pure half of the goal surface.
 *
 * The weight is on `goalIssues`, because it is the piece with a real problem to
 * solve: a broken goal has to be REPORTED (that is the whole point of the list's
 * `errors` array), but the parser's error record carries no ordinal, so the
 * ordinal is recovered here. Getting that wrong turns "goal 2 is missing
 * done_when" into "goal -1 is missing done_when", which is worse than useless in
 * a file with five goals.
 *
 * Pure: no DB, no git, no manifest I/O beyond `parseManifestString`.
 */
import { describe, expect, test } from 'bun:test';
import { extractGoals } from '../../projects/lib/agi-goals';
import { MANIFEST_FILENAME_YAML, parseManifestString } from '../../projects/triggers';
import {
  emptyGoalTaskCounts,
  goalIssues,
  openTaskCount,
  parseGoalStatusFilter,
  rawGoalEntries,
  serializeAgiGoal,
} from './wire';

const parse = (yaml: string) => parseManifestString(yaml, 'yaml', MANIFEST_FILENAME_YAML);

/** The manifest → issues path end to end, which is how the route uses both. */
const issuesFor = (yaml: string) => {
  const manifest = parse(yaml);
  const { specs, errors } = extractGoals(manifest);
  return goalIssues({ rawEntries: rawGoalEntries(manifest.raw), specs, errors });
};

const GOOD = `kortix_version: 2

goals:
  - slug: oil-desk
    title: Oil trades running 24/7
    done_when: A live account runs the strategy unattended for 7 days.
    status: active
    push: "0 0 9 * * *"
`;

describe('serializeAgiGoal', () => {
  test('carries the authored fields plus the derived trigger slug and rollup', () => {
    const [goal] = extractGoals(parse(GOOD)).specs;
    const counts = { ...emptyGoalTaskCounts(), doing: 2, blocked: 1, done: 5 };

    expect(serializeAgiGoal(goal, counts)).toEqual({
      slug: 'oil-desk',
      title: 'Oil trades running 24/7',
      done_when: 'A live account runs the strategy unattended for 7 days.',
      status: 'active',
      push: '0 0 9 * * *',
      // Unqualified goals are advanced by the platform AGI, not the project
      // default agent — the reserved name resolves without a manifest entry.
      agent: 'kortix-agi',
      timezone: 'UTC',
      path: 'kortix.yaml#goals.oil-desk',
      trigger_slug: 'goal-oil-desk',
      task_counts: counts,
      // done is terminal, so it is counted but never "open".
      open_task_count: 3,
    });
  });

  test('an on-demand goal reports no push and no trigger', () => {
    const [goal] = extractGoals(
      parse('kortix_version: 2\ngoals:\n  - slug: hire\n    done_when: Signed.\n'),
    ).specs;
    const wire = serializeAgiGoal(goal, emptyGoalTaskCounts());

    expect(wire.push).toBeNull();
    expect(wire.trigger_slug).toBeNull();
    expect(wire.open_task_count).toBe(0);
  });
});

describe('openTaskCount', () => {
  test('every non-terminal status counts, and only those', () => {
    const counts = {
      backlog: 1,
      todo: 1,
      doing: 1,
      blocked: 1,
      review: 1,
      done: 100,
      cancelled: 100,
    };
    expect(openTaskCount(counts)).toBe(5);
  });

  test('a status the vocabulary does not know is not silently counted as open', () => {
    expect(openTaskCount({ ...emptyGoalTaskCounts(), archived_by_a_newer_deploy: 9 })).toBe(0);
  });
});

describe('goalIssues — the silent-goal fix', () => {
  test('a goal rejected for a missing done_when is reported at its own index', () => {
    const issues = issuesFor(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
  - slug: broken
    title: No criteria
`);

    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(1);
    expect(issues[0].slug).toBe('broken');
    expect(issues[0].message).toContain('done_when');
    expect(issues[0].path).toBe('kortix.yaml#goals.broken');
  });

  test('an entry with no slug at all keeps its ordinal and reports slug null', () => {
    const issues = issuesFor(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
  - title: nameless
    done_when: Done.
`);

    expect(issues).toEqual([
      {
        index: 1,
        slug: null,
        message: 'goals entry #2 is missing a slug',
        path: 'kortix.yaml#goals.(index-1)',
      },
    ]);
  });

  test('a scalar where a table belongs is located positionally', () => {
    const issues = issuesFor(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
  - just-a-string
`);

    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(1);
    expect(issues[0].slug).toBeNull();
    expect(issues[0].message).toContain('not a table');
  });

  test('two entries with the SAME defect get two different ordinals', () => {
    const issues = issuesFor(`kortix_version: 2

goals:
  - first-scalar
  - second-scalar
`);

    expect(issues.map((issue) => issue.index)).toEqual([0, 1]);
  });

  test('a duplicate slug is reported against the SECOND declaration, not the first', () => {
    const issues = issuesFor(`kortix_version: 2

goals:
  - slug: dupe
    done_when: Done.
  - slug: dupe
    done_when: Also done.
`);

    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe('dupe');
    // Index 0 parsed cleanly and became a spec; only index 1 is an error, and
    // handing it index 0 would point the reader at the wrong line.
    expect(issues[0].index).toBe(1);
  });

  test('a problem with the goals block itself has no entry to point at', () => {
    const issues = issuesFor('kortix_version: 2\ngoals:\n  oil: yes\n');

    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(-1);
    expect(issues[0].slug).toBeNull();
    expect(issues[0].message).toContain('must be a list');
  });

  test('a manifest-level failure the store synthesizes reports the same way', () => {
    expect(
      goalIssues({
        rawEntries: [],
        specs: [],
        errors: [{ slug: '(manifest)', path: 'kortix.yaml', error: 'bad indentation' }],
      }),
    ).toEqual([{ index: -1, slug: null, message: 'bad indentation', path: 'kortix.yaml' }]);
  });

  test('an error whose entry cannot be located degrades to -1 rather than lying', () => {
    expect(
      goalIssues({
        rawEntries: [],
        specs: [],
        errors: [{ slug: 'ghost', path: 'kortix.yaml#goals.ghost', error: 'nope' }],
      }),
    ).toEqual([{ index: -1, slug: 'ghost', message: 'nope', path: 'kortix.yaml#goals.ghost' }]);
  });

  test('a valid goal alongside a broken one is still parsed — errors never blank the list', () => {
    const manifest = parse(`kortix_version: 2

goals:
  - slug: broken
    title: No criteria
  - slug: fine
    done_when: Done.
`);
    const { specs, errors } = extractGoals(manifest);

    expect(specs.map((spec) => spec.slug)).toEqual(['fine']);
    expect(
      goalIssues({ rawEntries: rawGoalEntries(manifest.raw), specs, errors }).map(
        (issue) => issue.index,
      ),
    ).toEqual([0]);
  });
});

describe('rawGoalEntries', () => {
  test('a missing or non-list goals block yields no entries rather than throwing', () => {
    expect(rawGoalEntries(parse('kortix_version: 2\n').raw)).toEqual([]);
    expect(rawGoalEntries(parse('kortix_version: 2\ngoals:\n  oil: yes\n').raw)).toEqual([]);
    expect(rawGoalEntries(null)).toEqual([]);
  });
});

describe('parseGoalStatusFilter', () => {
  test('absent means every status', () => {
    expect(parseGoalStatusFilter(undefined)).toBe('all');
    expect(parseGoalStatusFilter('')).toBe('all');
  });

  test('each authored status is accepted verbatim', () => {
    for (const status of ['active', 'achieved', 'paused', 'abandoned']) {
      expect(parseGoalStatusFilter(status)).toBe(status as never);
    }
  });

  test('anything else is invalid — including a case variant, which the manifest would have normalized', () => {
    expect(parseGoalStatusFilter('Active')).toBeNull();
    expect(parseGoalStatusFilter('open')).toBeNull();
    expect(parseGoalStatusFilter('all')).toBeNull();
  });
});
