import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveSetupCompletion,
  orderStepsOpenFirst,
  type ProjectSetupProbe,
  type ProjectSetupStepKey,
} from './setup-steps';

const STEP_KEYS = ['connectors', 'triggers', 'skills', 'slack', 'team', 'agent'] as const;

const NOTHING_DONE: ProjectSetupProbe = {
  connectorCount: 0,
  triggerCount: 0,
  skillCount: 0,
  agentCount: 0,
  memberCount: 1,
  slackConnected: false,
};

describe('deriveSetupCompletion', () => {
  test('a brand-new project has nothing checked', () => {
    const done = deriveSetupCompletion(NOTHING_DONE);
    for (const key of STEP_KEYS) expect(done[key]).toBe(false);
  });

  test('every step key gets an answer — no step is silently absent', () => {
    expect(Object.keys(deriveSetupCompletion(NOTHING_DONE)).sort()).toEqual([...STEP_KEYS].sort());
  });

  // The one real off-by-one on this surface. The creator is a member from the
  // moment the project exists, so `> 0` would tick "Invite your team" for
  // everyone, forever — and, because the checklist hides itself once every
  // step is done, it would also hide the checklist a step early.
  test('the team step needs a SECOND member, not just the creator', () => {
    expect(deriveSetupCompletion({ ...NOTHING_DONE, memberCount: 0 }).team).toBe(false);
    expect(deriveSetupCompletion({ ...NOTHING_DONE, memberCount: 1 }).team).toBe(false);
    expect(deriveSetupCompletion({ ...NOTHING_DONE, memberCount: 2 }).team).toBe(true);
  });

  test('each count-backed step ticks on its own count and on nothing else', () => {
    for (const [field, key] of [
      ['connectorCount', 'connectors'],
      ['triggerCount', 'triggers'],
      ['skillCount', 'skills'],
      ['agentCount', 'agent'],
    ] as const) {
      const done = deriveSetupCompletion({ ...NOTHING_DONE, [field]: 1 });
      expect(done[key]).toBe(true);
      for (const other of STEP_KEYS) {
        if (other !== key) expect(done[other]).toBe(false);
      }
    }
  });

  test('Slack is a boolean install probe, not a count', () => {
    expect(deriveSetupCompletion({ ...NOTHING_DONE, slackConnected: true }).slack).toBe(true);
  });
});

describe('orderStepsOpenFirst', () => {
  const steps = STEP_KEYS.map((key) => ({ key }));
  const noneDone = deriveSetupCompletion(NOTHING_DONE);
  const someDone = deriveSetupCompletion({
    ...NOTHING_DONE,
    triggerCount: 1,
    memberCount: 2,
  });

  test('open steps come first', () => {
    const ordered = orderStepsOpenFirst(steps, someDone).map((s) => s.key);
    const firstDone = ordered.findIndex((key) => someDone[key]);
    // Nothing open appears after the first done step.
    expect(ordered.slice(firstDone).every((key) => someDone[key])).toBe(true);
    expect(ordered.slice(firstDone)).toEqual(['triggers', 'team']);
  });

  // Without order-preserving partitioning the two groups would reshuffle
  // internally every time one probe resolved, so rows would move for reasons
  // the reader cannot see.
  test('declaration order survives inside each group', () => {
    expect(orderStepsOpenFirst(steps, noneDone).map((s) => s.key)).toEqual([...STEP_KEYS]);
    expect(orderStepsOpenFirst(steps, someDone).map((s) => s.key)).toEqual([
      'connectors',
      'skills',
      'slack',
      'agent',
      'triggers',
      'team',
    ]);
  });

  // Reordering happens during render. Mutating the prop would reorder the
  // caller's array as a side effect of drawing.
  test('the input array is never mutated', () => {
    const input: { key: ProjectSetupStepKey }[] = STEP_KEYS.map((key) => ({ key }));
    const before = input.map((s) => s.key);
    const out = orderStepsOpenFirst(input, someDone);
    expect(input.map((s) => s.key)).toEqual(before);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(input.length);
  });

  test('an all-done and an all-open list both keep declaration order', () => {
    const allDone = deriveSetupCompletion({
      connectorCount: 1,
      triggerCount: 1,
      skillCount: 1,
      agentCount: 1,
      memberCount: 2,
      slackConnected: true,
    });
    expect(orderStepsOpenFirst(steps, allDone).map((s) => s.key)).toEqual([...STEP_KEYS]);
    expect(orderStepsOpenFirst(steps, noneDone).map((s) => s.key)).toEqual([...STEP_KEYS]);
  });
});

const checklistSource = readFileSync(join(import.meta.dir, 'setup-checklist.tsx'), 'utf8');
const stepsSource = readFileSync(join(import.meta.dir, 'setup-steps.ts'), 'utf8');

describe('the source assertions below are reading the right files', () => {
  test('both files loaded and contain their anchors', () => {
    expect(checklistSource).toContain('export function ProjectSetupChecklist');
    expect(stepsSource).toContain('export function deriveSetupCompletion');
  });
});

describe('a hidden checklist costs nothing', () => {
  // Every probe is gated on `wants()`, which is gated on `live`, which is
  // false until storage says the checklist is not hidden. A query added
  // without that gate would fire on project home for a checklist nobody sees.
  test('every query is enabled through wants(), never unconditionally', () => {
    const enables = [...checklistSource.matchAll(/enabled: (.+),/g)].map((m) => m[1]);
    expect(enables.length).toBeGreaterThan(0);
    for (const enabled of enables) expect(enabled).toContain('wants(');
  });

  // The whole band waits for the full picture. Painting earlier means
  // painting an order and a count that are both still wrong, then correcting
  // them in front of the reader.
  test('nothing renders until every probe has answered', () => {
    expect(checklistSource).toContain('const open = settled && !allDone;');
    expect(checklistSource).not.toContain('const open = live && !allDone;');
    // Every probe is part of the gate — a new query added without a clause
    // here would let the band paint before that step's answer is known.
    for (const probe of ['connectors', 'triggers', 'slack', 'access', 'detail']) {
      expect(checklistSource).toMatch(
        new RegExp(`${probe}\\.isSuccess \\|\\| ${probe}\\.isError`),
      );
    }
  });

  // A count that is visible is a count that is true — it can never read
  // "0 of 6" on its way to the real number, because the band it lives in does
  // not exist yet.
  test('the counter has no presence gate of its own', () => {
    expect(checklistSource).toContain('{completed} of {steps.length}');
    expect(checklistSource).not.toContain('{settled && (');
  });

  test('wants() requires live, and live requires a settled storage read', () => {
    expect(checklistSource).toContain(
      'const wants = (key: ProjectSetupStepKey) => live && steps.some((s) => s.key === key);',
    );
    expect(checklistSource).toContain('const live = hidden === false;');
  });

  // The two hooks that take a projectId instead of an `enabled` flag.
  test('the projectId-gated hooks are handed null when their step is absent', () => {
    expect(checklistSource).toContain("useProjectTriggers(wants('triggers') ? projectId : null)");
    expect(checklistSource).toContain("useSlackInstall(wants('slack') ? projectId : null)");
  });

  // The server cannot read localStorage, so the snapshot it returns must be
  // the "unknown" sentinel — anything else either fires the probes during SSR
  // or desyncs from the client's first render.
  test('the server snapshot is the unknown sentinel, not a boolean', () => {
    expect(checklistSource).toContain('() => CHECKLIST_HIDDEN_UNKNOWN');
    expect(stepsSource).toContain('export const CHECKLIST_HIDDEN_UNKNOWN = null;');
  });
});

/**
 * Motion rules the doctrine cares about here. These are cheap source pins on
 * decisions that are easy to undo by accident and impossible to see in a diff.
 */
describe('the checklist motion follows the house rules', () => {
  // `ease-in` alone is banned; `ease-in-out` is the correct curve for the
  // re-rank, which is an element already on screen moving to a new place.
  test('no bare ease-in — it reads as sluggish', () => {
    expect(checklistSource.replace(/ease-in-out/g, '')).not.toContain('ease-in');
  });

  test('the re-rank is a layout move on the in-out curve, and opts out under reduced motion', () => {
    expect(checklistSource).toContain('<m.div layout transition={REORDER}>');
    expect(checklistSource).toContain('const REORDER = { duration: 0.2, ease: [0.77, 0, 0.175, 1] }');
    expect(checklistSource).toContain('return reduceMotion ? row : (');
  });

  test('the list is ordered through the pure helper, never by sorting the prop', () => {
    expect(checklistSource).toContain('orderStepsOpenFirst(steps, done).map((step) =>');
    expect(checklistSource).not.toContain('steps.sort(');
  });

  test('the exit is faster than the enter', () => {
    const enter = Number(checklistSource.match(/const BAND_ENTER = \{ duration: ([\d.]+)/)![1]);
    const exit = Number(checklistSource.match(/const BAND_EXIT = \{ duration: ([\d.]+)/)![1]);
    expect(exit).toBeLessThan(enter);
    // Product UI ceiling. A band this size has no business over 300ms.
    expect(enter).toBeLessThanOrEqual(0.3);
  });

  test('every animated surface ships a reduced-motion branch', () => {
    expect(checklistSource).toContain('useReducedMotion()');
    // The height animation is the vestibular trigger, so reduced motion must
    // opt out of it entirely rather than merely shortening it.
    expect(checklistSource).toContain("reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }");
  });

  // Six checks popping on every paint is noise; one popping when the user
  // returns from doing the work is the payoff. `initial={false}` is the whole
  // difference and it is one word to delete.
  test('a step check animates on completion, never on mount', () => {
    // Both indicator glyphs, and nothing else in the row, start AT their
    // target rather than animating to it.
    expect((checklistSource.match(/initial=\{false\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(checklistSource).toContain('animate={{ opacity: done ? 0 : 1 }}');
    expect(checklistSource).toContain('animate={{ opacity: done ? 1 : 0');
  });

  // The regression this replaced: open drew a 1px CSS border on a `size-4`
  // box (Ø 14.72px) while done centred a `size-4.5` filled glyph inside it
  // (Ø ~16.5px). Two diameters drawn two different ways cannot line up in a
  // column. Both states must be one glyph at one size in one lane.
  test('both indicator states are the same glyph size in the same lane', () => {
    const lane = checklistSource.slice(
      checklistSource.indexOf('<span aria-hidden className="relative size-4.5 shrink-0">'),
      checklistSource.indexOf('min-w-0 flex-1 truncate'),
    );
    expect(lane).toContain('<CircleIcon className="text-border size-4.5" />');
    expect(lane).toContain('<CheckCircleIcon weight="fill" className="text-kortix-blue size-4.5" />');
    // Every glyph in the lane is the same size, and the lane matches it.
    expect([...lane.matchAll(/size-[\d.]+/g)].map((m) => m[0])).toEqual([
      'size-4.5',
      'size-4.5',
      'size-4.5',
    ]);
    // The circle is never drawn by a CSS border again — that was the second
    // mechanism, and having two is what made them disagree. (`text-border` is
    // the ring's COLOUR and stays; it draws nothing.)
    expect(lane).not.toContain('rounded-full');
    expect(lane).not.toContain('border-border');
    // Stacked on one centre, so swapping ring for disc moves nothing.
    expect((lane.match(/absolute inset-0 flex/g) ?? []).length).toBe(2);
  });

  // Match the motion PROPS, not the English word — the file's own comments
  // explain why there is no stagger, and a prose match would fail on those.
  test('no stagger — the delay would be billed to the reader on every paint', () => {
    expect(checklistSource).not.toMatch(/\bdelay:/);
    expect(checklistSource).not.toContain('staggerChildren');
    expect(checklistSource).not.toContain('delayChildren');
  });
});
