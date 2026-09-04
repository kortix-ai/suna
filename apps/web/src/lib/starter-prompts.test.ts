import { describe, expect, test } from 'bun:test';

import { ROTATION_SIZE } from '@/stores/starter-prompt-rotation-store';
import {
  GENERAL_STARTER_PROMPTS,
  PINNED_STARTER_PROMPT,
  ROTATING_STARTER_PROMPTS,
  ROTATING_STARTER_PROMPT_IDS,
  STARTER_PROMPTS,
  STARTER_PROMPTS_BY_ID,
  WORKFORCE_STARTER_PROMPTS,
} from './starter-prompts';

describe('the prompt pool holds together', () => {
  // Ids are PERSISTED by the daily rotation, so a duplicate would let one
  // stored id resolve to two different rows depending on map insertion order.
  test('every id is unique across the whole pool', () => {
    const ids = STARTER_PROMPTS.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the pinned prompt is not also in the rotating pool', () => {
    expect(ROTATING_STARTER_PROMPT_IDS).not.toContain(PINNED_STARTER_PROMPT.id);
  });

  test('the pinned prompt leads the full list', () => {
    expect(STARTER_PROMPTS[0]).toBe(PINNED_STARTER_PROMPT);
    expect(STARTER_PROMPTS).toHaveLength(ROTATING_STARTER_PROMPTS.length + 1);
  });

  test('the ids export matches the prompts it is derived from, in order', () => {
    expect([...ROTATING_STARTER_PROMPT_IDS]).toEqual(ROTATING_STARTER_PROMPTS.map((p) => p.id));
  });

  test('the lookup map resolves every prompt, pinned included', () => {
    for (const prompt of STARTER_PROMPTS) {
      expect(STARTER_PROMPTS_BY_ID.get(prompt.id)).toBe(prompt);
    }
    expect(STARTER_PROMPTS_BY_ID.size).toBe(STARTER_PROMPTS.length);
  });

  // The whole point of the pool: six rows drawn from it should not repeat for
  // weeks. Far more than the band size, asserted so a future trim is a decision
  // rather than an accident.
  test('the rotating pool is deep enough for the band to stay varied', () => {
    expect(ROTATING_STARTER_PROMPTS.length).toBeGreaterThanOrEqual(50);
    expect(ROTATING_STARTER_PROMPTS.length).toBeGreaterThan(ROTATION_SIZE * 10);
  });
});

describe('the two halves of the rotating pool', () => {
  test('together they are exactly the rotating pool, workforce first', () => {
    expect(ROTATING_STARTER_PROMPTS).toEqual([
      ...WORKFORCE_STARTER_PROMPTS,
      ...GENERAL_STARTER_PROMPTS,
    ]);
  });

  // Disjoint by construction, and asserted because the reserved-slot pick draws
  // one from each and would double-count an id that appeared in both.
  test('no prompt is in both halves', () => {
    const general = new Set(GENERAL_STARTER_PROMPTS.map((prompt) => prompt.id));
    for (const prompt of WORKFORCE_STARTER_PROMPTS) {
      expect(general.has(prompt.id)).toBe(false);
    }
  });

  // The reserved slot needs enough workforce prompts that reserving one does
  // not show the same handful every week.
  test('the workforce half is deep enough to reserve a slot from', () => {
    expect(WORKFORCE_STARTER_PROMPTS.length).toBeGreaterThanOrEqual(10);
  });

  test('every workforce prompt names a Kortix primitive', () => {
    for (const prompt of WORKFORCE_STARTER_PROMPTS) {
      expect(`${prompt.label} ${prompt.prompt}`.toLowerCase()).toMatch(
        /agent|skill|trigger|memory|change request|connector|kortix\.yaml|repo/,
      );
    }
  });
});

describe('the pool sells the product, not a list of file conversions', () => {
  const allPrompts = STARTER_PROMPTS.map((prompt) => prompt.prompt.toLowerCase()).join(' ');

  /*
   * The rows that make this an AI Management System rather than a chat box.
   * An earlier pool had NONE of these — it was written under a rule that only
   * admitted `general-knowledge-worker` skills, and produced "Convert docs to
   * markdown". Asserted by primitive so a future trim has to be a decision.
   *
   * Every one of these is real in the shipped `base` template: agents live in
   * `.kortix/opencode/agents/`, skills in `.kortix/opencode/skills/`, triggers
   * are cron/webhook entries in `kortix.yaml`, memory is `.kortix/memory/`,
   * and work lands through `kortix cr`.
   */
  for (const primitive of [
    'agent',
    'skill',
    'trigger',
    'memory',
    'change request',
    'kortix.yaml',
  ]) {
    test(`something in the pool asks the agent to work on ${primitive}`, () => {
      expect(allPrompts).toContain(primitive);
    });
  }

  // The specific row Jay called out. A prompt has to name a REASON someone has,
  // not a capability the runtime happens to have.
  test('no row is a bare file-format conversion', () => {
    const conversions = ROTATING_STARTER_PROMPTS.filter((prompt) =>
      /^(convert|import) /i.test(prompt.label),
    );
    expect(conversions.map((prompt) => prompt.label)).toEqual([]);
  });

  // Deliberately absent: this project has no market feed, so a row promising
  // live prices is a promise the first run cannot keep.
  test('nothing promises live market data', () => {
    const marketData = STARTER_PROMPTS.filter((prompt) =>
      /stock price|share price|ticker|live market/i.test(`${prompt.label} ${prompt.prompt}`),
    );
    expect(marketData.map((prompt) => prompt.id)).toEqual([]);
  });
});

describe('every prompt is renderable and sendable', () => {
  test('each has a non-empty id, label, prompt and icon', () => {
    for (const prompt of STARTER_PROMPTS) {
      expect(prompt.id.length).toBeGreaterThan(0);
      expect(prompt.label.trim().length).toBeGreaterThan(0);
      expect(prompt.prompt.trim().length).toBeGreaterThan(0);
      expect(typeof prompt.icon).toBeDefined();
    }
  });

  // The row truncates at one line. A label long enough to clip is a label that
  // tells you nothing, so this is a copy rule, not a layout guess.
  test('no label is long enough to truncate in the row', () => {
    const tooLong = STARTER_PROMPTS.filter((prompt) => prompt.label.length > 32);
    expect(tooLong.map((prompt) => prompt.label)).toEqual([]);
  });

  // A prompt is pasted into the composer as if the person typed it. One that
  // is a fragment reads as a broken paste.
  test('every prompt is a real sentence, not a fragment', () => {
    for (const prompt of STARTER_PROMPTS) {
      expect(prompt.prompt.length).toBeGreaterThan(40);
      expect(prompt.prompt.trim()).toMatch(/[.!?]$/);
    }
  });

  // The rule the file header sets: the agent takes its best shot instead of
  // opening with a questionnaire. The pinned prompt is the documented exception
  // — asking IS its job.
  test('only the pinned prompt opens by interrogating the user', () => {
    const interrogators = ROTATING_STARTER_PROMPTS.filter((prompt) =>
      /^Ask (for|what|me) /.test(prompt.prompt),
    );
    expect(interrogators.map((prompt) => prompt.id)).toEqual([]);
    expect(PINNED_STARTER_PROMPT.prompt).toContain('Ask about my company');
  });
});
