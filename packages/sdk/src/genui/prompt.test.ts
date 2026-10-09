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
