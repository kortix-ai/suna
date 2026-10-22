import { describe, expect, test } from 'bun:test';

import {
  LINE_WIDTHS,
  LAST_LINE_WIDTHS,
  PROMPT_WIDTHS,
  PULSE_PERIOD_MS,
  TALL_PROMPT_WIDTHS,
  TOOL_WIDTHS,
  pulseDelayMs,
  savedSessionSkeletonShape,
  type SkeletonShape,
} from './saved-session-skeleton-shape';

/** Synthetic session ids in the route's UUID shape. */
const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, n) => `00000000-0000-4000-8000-${(n + 1).toString(16).padStart(12, '0')}`,
  );

/** Every placeholder in reading order: what the pulse wave walks through. */
function phasesInReadingOrder(shape: SkeletonShape): number[] {
  const phases: number[] = [];
  for (const turn of shape.turns) {
    phases.push(turn.prompt.phase);
    if (turn.tool) phases.push(turn.tool.phase);
    for (const paragraph of turn.reply) {
      if (paragraph.kind === 'block') phases.push(paragraph.phase);
      else for (const line of paragraph.lines) phases.push(line.phase);
    }
  }
  phases.push(shape.composerPhase);
  return phases;
}

describe('one shape per session', () => {
  test('the same session always draws the same rows', () => {
    // The server render, the client render, and the route's loading boundary
    // each draw the placeholder. Rows that differed between them would fail
    // hydration, or jump when the page takes over from the boundary.
    for (const id of ids(50)) {
      expect(savedSessionSkeletonShape(id)).toEqual(savedSessionSkeletonShape(id));
    }
  });

  test('different sessions draw different rows', () => {
    const shapes = new Set(ids(40).map((id) => JSON.stringify(savedSessionSkeletonShape(id))));
    expect(shapes.size).toBeGreaterThanOrEqual(36);
  });

  test('an empty id still draws a conversation', () => {
    const shape = savedSessionSkeletonShape('');
    expect(shape.turns.length).toBeGreaterThanOrEqual(3);
  });
});

describe('every shape reads as a conversation', () => {
  const shapes = ids(500).map(savedSessionSkeletonShape);

  test('three or four turns, each a prompt and a reply', () => {
    for (const shape of shapes) {
      expect(shape.turns.length).toBeGreaterThanOrEqual(3);
      expect(shape.turns.length).toBeLessThanOrEqual(4);
      for (const turn of shape.turns) {
        expect(turn.reply.length).toBeGreaterThanOrEqual(1);
        expect(turn.reply.length).toBeLessThanOrEqual(2);
      }
    }
  });

  test('a reply opens with text, and a paragraph ends on a short line', () => {
    for (const shape of shapes) {
      for (const turn of shape.turns) {
        const [first, ...rest] = turn.reply;
        expect(first?.kind).toBe('text');
        if (first?.kind === 'text') expect(first.lines.length).toBeGreaterThanOrEqual(2);
        expect(rest.filter((paragraph) => paragraph.kind === 'block').length).toBeLessThanOrEqual(1);
        for (const paragraph of turn.reply) {
          if (paragraph.kind !== 'text') continue;
          expect(paragraph.lines.length).toBeLessThanOrEqual(4);
          const last = paragraph.lines.at(-1);
          expect(LAST_LINE_WIDTHS).toContain(last?.width as never);
          for (const line of paragraph.lines.slice(0, -1)) {
            expect(LINE_WIDTHS).toContain(line.width as never);
          }
        }
      }
    }
  });

  test('a prompt that wraps to a second line is a wide one', () => {
    for (const shape of shapes) {
      for (const { prompt } of shape.turns) {
        expect(prompt.tall ? TALL_PROMPT_WIDTHS : PROMPT_WIDTHS).toContain(prompt.width as never);
      }
    }
  });

  test('every option shows up, so the variety is real', () => {
    const seen = new Set<string>();
    for (const shape of shapes) {
      seen.add(`turns:${shape.turns.length}`);
      for (const turn of shape.turns) {
        seen.add(`prompt:${turn.prompt.width}`);
        seen.add(`tall:${turn.prompt.tall}`);
        seen.add(`tool:${turn.tool?.width ?? 'none'}`);
        seen.add(`paragraphs:${turn.reply.length}`);
        for (const paragraph of turn.reply) {
          seen.add(`kind:${paragraph.kind}`);
          if (paragraph.kind !== 'text') continue;
          seen.add(`lines:${paragraph.lines.length}`);
          for (const line of paragraph.lines) seen.add(`width:${line.width}`);
        }
      }
    }
    const expected = [
      'turns:3',
      'turns:4',
      'tall:true',
      'tall:false',
      'tool:none',
      'paragraphs:1',
      'paragraphs:2',
      'kind:text',
      'kind:block',
      'lines:1',
      'lines:2',
      'lines:3',
      'lines:4',
      ...[...PROMPT_WIDTHS, ...TALL_PROMPT_WIDTHS].map((width) => `prompt:${width}`),
      ...TOOL_WIDTHS.map((width) => `tool:${width}`),
      ...[...LINE_WIDTHS, ...LAST_LINE_WIDTHS].map((width) => `width:${width}`),
    ];
    expect(expected.filter((option) => !seen.has(option))).toEqual([]);
  });
});

describe('the pulse walks down the rows', () => {
  test('phases count the placeholders in reading order, composer last', () => {
    for (const id of ids(200)) {
      const shape = savedSessionSkeletonShape(id);
      const phases = phasesInReadingOrder(shape);
      expect(phases).toEqual(phases.map((_, index) => index));
      expect(shape.phases).toBe(phases.length);
    }
  });

  test('one wave per pulse: each row starts after the row above it, top to bottom', () => {
    // A negative delay starts the pulse part-way through its cycle, so every
    // row is on screen and moving from the first frame; nothing waits.
    for (const id of ids(200)) {
      const { phases } = savedSessionSkeletonShape(id);
      const starts = Array.from({ length: phases }, (_, phase) => {
        const delay = pulseDelayMs(phase, phases);
        expect(delay).toBeLessThanOrEqual(0);
        expect(delay).toBeGreaterThan(-PULSE_PERIOD_MS);
        // When, in the first cycle, this row's pulse begins.
        return (PULSE_PERIOD_MS + delay) % PULSE_PERIOD_MS;
      });
      expect(starts[0]).toBe(0);
      const step = PULSE_PERIOD_MS / phases;
      starts.slice(1).forEach((start, index) => {
        expect(start).toBeGreaterThan(starts[index] as number);
        expect(Math.abs(start - (index + 1) * step)).toBeLessThanOrEqual(0.5);
      });
    }
  });
});
