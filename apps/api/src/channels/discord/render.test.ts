import { describe, expect, test } from 'bun:test';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { pressData } from '../core/command-press';
import type { QuestionMessage } from '../core/questions';
import { COMMAND_SELECT_ID, discordCommandMessage, discordQuestionMessage } from './render';

const ROWS_MAX = 5;
const BUTTONS_PER_ROW_MAX = 5;

/** Every limit Discord enforces on a message we send. */
function withinDiscordLimits(body: { content: string; components: Array<{ components: Array<Record<string, any>> }> }) {
  expect(body.content.length).toBeLessThanOrEqual(CHANNELS.discord.messageChars);
  expect(body.components.length).toBeLessThanOrEqual(ROWS_MAX);
  for (const row of body.components) {
    expect(row.components.length).toBeLessThanOrEqual(BUTTONS_PER_ROW_MAX);
    for (const c of row.components) {
      if (c.custom_id) expect(c.custom_id.length).toBeLessThanOrEqual(CHANNELS.discord.buttons.dataBytes);
      if (c.label) expect(c.label.length).toBeLessThanOrEqual(80);
      for (const o of c.options ?? []) {
        expect(o.label.length).toBeLessThanOrEqual(100);
        expect(o.value.length).toBeLessThanOrEqual(100);
      }
    }
  }
}

describe('an agent question as a Discord message', () => {
  test('a page of a multi-select step: one option a row, then ‹ Back, More › and Done in one row', () => {
    const id = '0b2f7c1e-4d3a-4f7e-9c11-2a6f5d8e9b10';
    const m: QuestionMessage = {
      questions: [{ question: 'Which drinks?', header: 'Drinks', multiple: true, options: ['Tea', 'Coffee', 'Juice', 'Water', 'Milk'].map((label) => ({ label, description: '' })) }],
      footer: { kind: 'step', many: true, typed: true },
      buttons: ['Tea', 'Coffee', 'Juice', 'Water'].map((label, i) => ({ label, data: `kq:${id}:2.${i}`, ...(i === 1 ? { ticked: true } : {}) })),
      back: `kq:${id}:2.p0`,
      more: `kq:${id}:2.p2`,
      done: `kq:${id}:2.d`,
      step: { at: 3, count: 3 },
    };
    const body = discordQuestionMessage(m);
    withinDiscordLimits(body);
    expect(body.content).toStartWith('**Question 3 of 3 · Drinks**\nWhich drinks? (pick one or more)');
    expect(body.content).toEndWith('Pick each option you want, then Done, or type your own answer.');
    expect(body.components.map((row) => row.components.map((c) => ('label' in c ? c.label : '')))).toEqual([
      ['Tea'],
      ['✓ Coffee'],
      ['Juice'],
      ['Water'],
      ['‹ Back', 'More ›', 'Done ›'],
    ]);
    // A ticked option is green (success); Done is the primary button.
    expect((body.components[1]!.components[0] as { style: number }).style).toBe(3);
    expect((body.components[4]!.components[2] as { style: number }).style).toBe(1);
  });

  test('a question without buttons is text only, and a very long one is clipped to one message', () => {
    const body = discordQuestionMessage({
      questions: [{ question: 'x'.repeat(5_000), header: '', options: [{ label: 'a', description: '' }] }],
      footer: { kind: 'ask', buttons: false, numbered: false },
    });
    expect(body.components).toEqual([]);
    withinDiscordLimits(body);
    expect(body.content).toEndWith('Reply in this conversation with your answer.');
  });
});

describe('a command reply as a Discord message', () => {
  test("a list's options are one select menu whose values are the press tokens; page turns and actions are buttons", () => {
    const options = Array.from({ length: 9 }, (_, i) => ({
      label: `Model ${i} ${'·'.repeat(120)}`,
      current: i === 2,
      press: { name: 'model' as const, pick: `ref${i}` },
    }));
    const body = discordCommandMessage({
      kind: 'choices',
      title: 'Models',
      options,
      page: 0,
      pages: 2,
      more: { name: 'model', page: 1 },
      usage: 'Pick a model, or send /model <id>.',
      actions: [{ label: 'Stop', press: { name: 'stop' } }],
    });
    withinDiscordLimits(body);
    const select = body.components[0]!.components[0] as { type: number; custom_id: string; options: Array<{ value: string; default?: boolean }> };
    expect(select.type).toBe(3);
    expect(select.custom_id).toBe(COMMAND_SELECT_ID);
    expect(select.options.map((o) => o.value)).toEqual(options.map((o) => pressData(o.press)));
    expect(select.options.filter((o) => o.default)).toHaveLength(1);
    expect(body.components[1]!.components.map((c) => (c as { custom_id: string }).custom_id)).toEqual(['kc:model:p1']);
    expect(body.components[2]!.components.map((c) => (c as { custom_id: string }).custom_id)).toEqual(['kc:stop']);
    expect(body.content).toBe('**Models** (page 1 of 2)\nPick a model, or send /model <id>.');
  });

  test('a panel with an https link gets an Open in Kortix link button; another link stays in the text', () => {
    const panel = discordCommandMessage({ kind: 'panel', title: 'Status', rows: [{ label: 'Model', value: 'synthetic' }], url: 'https://kortix.test/p/1' });
    expect(panel.components.at(-1)!.components[0]).toMatchObject({ type: 2, style: 5, label: 'Open in Kortix', url: 'https://kortix.test/p/1' });
    const local = discordCommandMessage({ kind: 'panel', title: 'Status', rows: [], url: 'http://localhost:3000/p/1' });
    expect(local.components).toEqual([]);
    expect(local.content).toEndWith('http://localhost:3000/p/1');
  });
});
