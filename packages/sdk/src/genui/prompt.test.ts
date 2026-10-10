import { describe, expect, test } from 'bun:test';

import { GENUI_BLOCKS, GENUI_SPECS } from './catalog';
import { buildGenuiPrompt, GENUI_PROMPT_VERSION } from './prompt';

describe('prompt', () => {
  const prompt = buildGenuiPrompt();
  test('teaches every block and the Kortix rules, without tools or state', () => {
    for (const name of ['Stack(', 'Card(', 'BarChart(', 'Map(', 'Tabs(', 'Accordion(', 'RankedList(']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('```openui');
    expect(prompt).toContain('Never invent numbers or coordinates');
    expect(prompt).not.toContain('Query(');
    expect(prompt).not.toContain('Mutation(');
    expect(prompt).not.toContain('$');
  });
  test('teaches positional arguments, component children, and argument order', () => {
    expect(prompt).toContain('Arguments are positional only');
    expect(prompt).toContain('never Stat(label: "Users", value: "900")');
    expect(prompt).toContain('Children of Stack, Tab, and AccordionItem are component references, never plain strings');
    expect(prompt).toContain('Map(markers, source, zoom?, route?)');
    expect(prompt).toContain('Stat delta is at most 24 characters');
    expect(prompt).toContain('Table takes exactly columns, rows, caption?');
  });
  test('puts the closing fence on its own line', () => {
    expect(prompt).toContain('Put the closing ``` on its own line, never right after the last statement.');
  });
  test('size and version', () => {
    expect(prompt.length).toBeLessThan(16000);
    expect(GENUI_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
  test('GENUI_BLOCKS lists exactly the specs marked as blocks', () => {
    const blocks = Object.values(GENUI_SPECS)
      .filter((spec) => spec.block)
      .map((spec) => spec.name)
      .sort();
    expect([...GENUI_BLOCKS].sort() as string[]).toEqual(blocks);
  });
});
