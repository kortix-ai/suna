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
  test('teaches when each PieChart variant fits', () => {
    for (const variant of ['donut', 'focus', 'ring', 'treemap', 'gauge', 'stack']) {
      expect(prompt).toContain(`${variant}:`);
    }
  });
  test('teaches that several images are a Stack of Image blocks (a gallery), never a ranked list', () => {
    expect(prompt).toContain('To show 2 or more images, write a Stack of Image blocks and nothing else');
    expect(prompt).toContain('Never put images in a RankedList or in Cards only to show them');
  });
  test('teaches the agent to geocode a named place before it writes a Map, never to invent coordinates', () => {
    expect(prompt).toContain('To map a place you know only by name or address, look up its coordinates first');
    expect(prompt).toContain('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=');
    expect(prompt).toContain('If the lookup finds nothing, give a link instead of a Map');
  });
  test('maps content to blocks and forbids markdown tables for data', () => {
    expect(prompt).toContain('Never write a markdown table for data');
    for (const trigger of [
      'headline numbers → a StatRow of Stats',
      'a ranked or "best of" list → RankedList',
      'options to choose between → Compare',
      'one number across several items → BarChart',
      'a value over time → LineChart',
      'shares of a whole → PieChart',
      'a plan, an itinerary, or steps with sections → Accordion or Tabs',
      'named places → Map',
    ]) {
      expect(prompt).toContain(trigger);
    }
    expect(prompt).not.toContain('Prose stays the default');
  });
  test('asks for a photo, rating, and price on place and product cards, from tool results', () => {
    expect(prompt).toContain('A Card for a hotel, product, or place carries its photo, rating, and price when a tool result gives them');
    expect(prompt).toContain('og:image');
  });
  test('puts each item photo on its own Card, never in a separate gallery', () => {
    expect(prompt).toContain("Put an item's photo in its own Card's image argument, never in a separate Image gallery");
  });
  test('picks the Marker value from what the user asked about', () => {
    expect(prompt).toContain("A Marker's value is a number the user asked about: the rating when they want the best places, the price when they care about cost");
    expect(prompt).toContain("Never a category or a word (no 'Luxury'): leave it empty instead");
  });
  test('gives every Card in a card list an image, and says where to find one', () => {
    expect(prompt).toContain('Every Card in a list of 2 or more Cards carries an image, whatever the topic');
    expect(prompt).toContain('https://en.wikipedia.org/api/rest_v1/page/summary/<Title>');
  });
  test('lets the model pick a list or a grid for Cards, and says which fits', () => {
    expect(prompt).toContain('A Stack of 2 or more Cards shows as a grid of big images when the images are photos, and as a list with small thumbnails when they are logos or icons');
    expect(prompt).toContain('Stack([a, b, c], "col", "list")');
  });
  test('answers "show me as cards" in the reply, not with the show tool or a built page', () => {
    expect(prompt).toContain('When the user asks to see an answer as cards, a list, a chart, a table, or a map, write an openui block in this reply');
    expect(prompt).toContain('Do not call the show tool for it, and do not build a page or write a file, unless they ask you to build or save one.');
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
