import { describe, expect, test } from 'bun:test';

import { GENUI_BLOCKS, GENUI_SPECS } from './catalog';
import { splitGenui } from './fence';
import { parseGenui } from './parse';
import { buildGenuiPrompt, GENUI_PROMPT_VERSION } from './prompt';

describe('prompt', () => {
  const prompt = buildGenuiPrompt();
  test('teaches every block and the Kortix rules, without tools or state', () => {
    for (const name of ['Stack(', 'Card(', 'BarChart(', 'Map(', 'Tabs(', 'Accordion(', 'RankedList(', 'Steps(', 'Checklist(']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('```openui');
    expect(prompt).toContain('Never invent them');
    expect(prompt).not.toContain('Query(');
    expect(prompt).not.toContain('Mutation(');
    expect(prompt).not.toContain('$');
  });
  test('teaches positional arguments, component children, and argument order', () => {
    expect(prompt).toContain('Arguments are positional only');
    expect(prompt).toContain('never Stat(label: "Users", value: "900")');
    expect(prompt).toContain('Children of Stack, Tab, and AccordionItem are component references, never plain strings');
    expect(prompt).toContain('Map(markers, source, zoom?, route?)');
    expect(prompt).toContain('Stat delta and Badge label are at most 24 characters');
    expect(prompt).toContain('Checklist items and Table caption are at most 120 characters');
    expect(prompt).toContain('Table takes exactly columns, rows, caption?');
  });
  test('teaches when each PieChart variant fits', () => {
    for (const variant of ['donut', 'focus', 'ring', 'treemap', 'gauge', 'stack']) {
      expect(prompt).toContain(`${variant}:`);
    }
  });
  test('teaches that several images are a Stack of Image blocks (a gallery), never a ranked list', () => {
    expect(prompt).toContain('A gallery is a Stack of Images and nothing else');
    expect(prompt).toContain('Never put images in a RankedList or in Cards only to show them');
  });
  test('teaches the agent to geocode every named place in one call before it writes a Map, never to invent coordinates', () => {
    expect(prompt).toContain('look them all up in ONE bash call');
    expect(prompt).toContain('https://nominatim.openstreetmap.org/search -d format=jsonv2 -d limit=1 --data-urlencode');
    expect(prompt).toContain('give links instead of a Map');
    // tr + xargs -0: a quote in a place name (Saint Mark's) does not end xargs' input.
    expect(prompt).toContain('| tr "\\n" "\\0" | xargs -0 -I{}');
  });
  test('maps content to blocks and forbids markdown tables for data', () => {
    expect(prompt).toContain('Never write a markdown table for data');
    for (const trigger of [
      'headline numbers → StatRow',
      'a ranked "best of" list without photos → RankedList',
      'a spec-by-spec table or pros and cons of 2 to 4 named options → Compare',
      'One number across items → BarChart',
      'A value over time → LineChart',
      'Shares of a whole or survey answers → PieChart',
      'leg by leg (home → station → airport) → Steps',
      'things to bring, buy, prepare, or confirm → Checklist',
      'Choosing how to do something (taxi or train, which flight) is always Cards, never Compare',
      'named places the user goes to or picks from (stations, hotels, sights) → Map',
    ]) {
      expect(prompt).toContain(trigger);
    }
    expect(prompt).not.toContain('Prose stays the default');
    expect(prompt).toContain('a one-line opinion with no options to compare');
  });
  test('gets every photo in one image_search call and puts it on its own item', () => {
    expect(prompt).toContain('Get every photo for the reply in ONE image_search call');
    expect(prompt).toContain('num_results 3');
    expect(prompt).toContain('Without image_search, use a web_search result image');
    expect(prompt).toContain("in the item's own image argument, never in a separate gallery");
    expect(prompt).toContain('Badge("My first choice", "good") marks your pick');
    expect(prompt).toContain('First run ONE web_search batch');
    expect(prompt).toContain('Leave price empty when no tool result gives it');
    expect(prompt).toContain('A fare or timetable time needs a tool result');
  });
  test('picks the Marker value from what the user asked about', () => {
    expect(prompt).toContain("A Marker's value is the number the user asked about");
    expect(prompt).toContain("never a word (no 'Luxury')");
  });
  test('lets the model pick a list or a grid for Cards, and says which fits', () => {
    expect(prompt).toContain('Set a Stack of Cards to list when the text matters more than the picture');
    expect(prompt).toContain('Stack([a, b], "col", "list")');
  });
  test('answers "show me as cards" in the reply, not with the show tool or a built page', () => {
    expect(prompt).toContain('When the user asks to see an answer as cards, a list, a chart, a table, or a map, write the block in this reply');
  });
  test('puts the closing fence on its own line', () => {
    expect(prompt).toContain('Put the closing ``` on its own line, never right after the last statement.');
  });
  test('teaches the shape of a visual answer: prose and one block per section', () => {
    expect(prompt).toContain('## The shape of a visual answer');
    expect(prompt).toContain('A guide, a trip, or a how-to has 4 to 10 blocks');
    expect(prompt).toContain('at least one sentence of prose before the first block and between two blocks');
    expect(prompt).toContain('Show the same data once');
    expect(prompt).toContain('Never put the main steps or options in an Accordion or Tabs');
    expect(prompt).toContain('Steps holds 3 to 8 Steps, one leg or action each');
  });
  test('drops the rules that kept guides in prose, and lang-core boilerplate', () => {
    for (const gone of [
      'At most 3 blocks',
      'step-by-step instructions',
      'steps with sections → Accordion or Tabs',
      'og:image',
      'wikipedia',
      'Hoisting',
      'Final Verification',
      'forms for input',
    ]) {
      expect(prompt).not.toContain(gone);
    }
  });
  test('every openui example parses with a root and no issues', () => {
    const blocks = splitGenui(prompt).filter((segment) => segment.kind === 'genui');
    expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (const block of blocks) {
      if (block.kind !== 'genui') continue;
      const result = parseGenui(block.code, block.version);
      expect({ code: block.code, issues: result.issues }).toEqual({ code: block.code, issues: [] });
      expect(result.root).not.toBeNull();
    }
  });
  test('the examples follow their own rules: prose before every block, one photo per item', () => {
    let proseSince = 0;
    const photos: string[] = [];
    for (const segment of splitGenui(prompt)) {
      if (segment.kind !== 'genui') {
        // Headings are not prose: a heading-only section breaks the rule.
        proseSince += segment.text.split('\n').filter((line) => !/^\s{0,3}#/.test(line)).join('').replace(/\s/g, '').length;
        continue;
      }
      expect({ code: segment.code, proseSince: proseSince >= 20 }).toEqual({ code: segment.code, proseSince: true });
      proseSince = 0;
      photos.push(...(segment.code.match(/https:\/\/example\.com\/photos\/[\w.-]+/g) ?? []));
    }
    expect(photos.length).toBeGreaterThan(10);
    expect(photos.filter((url, i) => photos.indexOf(url) !== i)).toEqual([]);
  });
  test('answers at once on stated assumptions, never with a list of questions', () => {
    expect(prompt).toContain('Answer in this reply; never ask first.');
    expect(prompt).toContain('When a missing detail (dates, budget) changes the answer, assume the common case');
    expect(prompt).toContain('Never assume what the request already says');
    // The question is optional and comes after the closing line, never instead of it.
    expect(prompt).toContain('After it, ask one short question only when one missing detail would change your recommendation');
    expect(prompt).toContain('Ask nothing when the answer is complete or the user asked for plain text');
    expect(prompt).not.toContain('End with at most one short question');
    expect(prompt).toContain('never put questions in a Checklist');
  });
  test('a requested format beats the block rules', () => {
    expect(prompt).toContain('When the user asks for plain text, markdown, JSON, or no UI, write exactly that format and no block.');
  });
  test('keeps blocks from repeating each other, and keeps advice and instructions out of data slots', () => {
    expect(prompt).toContain("the actions inside a leg go only in that leg's own section");
    expect(prompt).toContain('add Cards or Steps for them only when they carry photos or facts the pins do not');
    expect(prompt).toContain('tips, and questions stay prose or a short numbered list of at most 5 items, one sentence each, never a Checklist, RankedList, Callout, or Cards');
    expect(prompt).toContain('A score out of 10 goes in subtitle with its review count (Old Town · Booking 9.3/10, 2,345 reviews)');
    expect(prompt).toContain('never halved and never a Badge');
    // Real-world actions only: an install guide stays prose with code fences at any length.
    expect(prompt).toContain('4 or more real-world actions in order are Steps, not prose or a numbered list.');
    expect(prompt).toContain('install or setup guide is prose with code fences, at any length.');
    expect(prompt).not.toContain('Actions that take more than 3 sentences are Steps');
    expect(prompt).toContain('never an instruction');
    expect(prompt).toContain('a single item, a day plan, or a schedule has no pick badge');
    expect(prompt).toContain('never "provided" or "supplied"');
    expect(prompt).toContain('except when the second block continues the first');
  });
  test('gets a photo for every row and retries a place lookup that missed', () => {
    expect(prompt).toContain('use the first fitting result of its own query');
    expect(prompt).toContain('look it up once more, in a second bash call, with its street address');
    expect(prompt).toContain('keep that result when its display_name has the same street and house number');
    expect(prompt).toContain('in a second bash call');
    expect(prompt).toContain('If fewer than 2 places are found, give links instead of a Map');
  });
  test('the travel example maps the places the user goes to', () => {
    expect(prompt).toContain('one bash call for the coordinates');
    expect(prompt).toContain('A trip guide also maps the airports and stations it names');
    expect(prompt).toMatch(/root = Map\(\[\w+, \w+\], "OpenStreetMap Nominatim"/);
  });
  test('lists every catalog component signature exactly once', () => {
    const names = prompt
      .split('\n')
      .map((line) => /^([A-Z]\w*)(\(.*\)) — (.+)$/.exec(line)?.[1])
      .filter((name): name is string => !!name);
    expect(names).toEqual(Object.keys(GENUI_SPECS));
  });
  test('every Steps example has 3 to 8 Steps, as the rule asks', () => {
    for (const block of splitGenui(prompt)) {
      if (block.kind !== 'genui') continue;
      for (const match of block.code.matchAll(/= Steps\(\[([^\]]*)\]\)/g)) {
        const count = match[1]!.split(',').length;
        expect({ steps: match[0], ok: count >= 3 && count <= 8 }).toEqual({ steps: match[0], ok: true });
      }
    }
  });
  test('size and version', () => {
    expect(prompt.length).toBeLessThan(19000);
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
