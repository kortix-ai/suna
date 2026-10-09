import { describe, expect, test } from 'bun:test';

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
    console.log(`prompt chars=${prompt.length} ~tokens=${Math.round(prompt.length / 4)} version=${GENUI_PROMPT_VERSION}`);
    expect(prompt.length).toBeLessThan(16000);
    expect(GENUI_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
});
