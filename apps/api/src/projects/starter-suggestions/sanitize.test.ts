import { describe, expect, it } from 'bun:test';
import { parseSuggestions, POOL_SIZE, MIN_ITEMS, MAX_LABEL_CHARS, MAX_PROMPT_CHARS } from './sanitize';

describe('parseSuggestions', () => {
  it('returns null for null input', () => {
    expect(parseSuggestions(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(parseSuggestions(undefined)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(parseSuggestions('')).toBe(null);
  });

  it('returns null for non-JSON string', () => {
    expect(parseSuggestions('not json at all')).toBe(null);
  });

  it('returns null for prose instead of JSON', () => {
    expect(parseSuggestions('This is just some prose text that is not JSON')).toBe(null);
  });

  it('parses a valid 9-item array', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(9);
    expect(result?.[0]).toEqual({ id: 'gen-0', label: 'Label 1', prompt: 'This is a valid prompt text here' });
    expect(result?.[8]).toEqual({ id: 'gen-8', label: 'Label 9', prompt: 'Ninth prompt to complete the pool' });
  });

  it('parses suggestions from { "suggestions": [...] } wrapper', () => {
    const input = JSON.stringify({
      suggestions: [
        { label: 'Label 1', prompt: 'This is a valid prompt text here' },
        { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
        { label: 'Label 3', prompt: 'Third prompt with enough characters' },
        { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
        { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
        { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      ],
    });
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(6);
    expect(result?.[0]).toEqual({ id: 'gen-0', label: 'Label 1', prompt: 'This is a valid prompt text here' });
  });

  it('parses fence-wrapped JSON (backticks)', () => {
    const input =
      '```\n' +
      JSON.stringify([
        { label: 'Label 1', prompt: 'This is a valid prompt text here' },
        { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
        { label: 'Label 3', prompt: 'Third prompt with enough characters' },
        { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
        { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
        { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      ]) +
      '\n```';
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(6);
  });

  it('parses fence-wrapped JSON with json language specifier', () => {
    const input =
      '```json\n' +
      JSON.stringify([
        { label: 'Label 1', prompt: 'This is a valid prompt text here' },
        { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
        { label: 'Label 3', prompt: 'Third prompt with enough characters' },
        { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
        { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
        { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      ]) +
      '\n```';
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(6);
  });

  it('returns null when fewer than MIN_ITEMS survive validation', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
    ]);
    const result = parseSuggestions(input);
    expect(result).toBe(null);
  });

  it('drops items with label exceeding MAX_LABEL_CHARS', () => {
    const overSize = 'x'.repeat(MAX_LABEL_CHARS + 1);
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: overSize, prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
    expect(result?.some((item) => item.label === overSize)).toBe(false);
  });

  it('drops items with prompt exceeding MAX_PROMPT_CHARS', () => {
    const overSize = 'x'.repeat(MAX_PROMPT_CHARS + 1);
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: 'Label 2', prompt: overSize },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
    expect(result?.some((item) => item.prompt === overSize)).toBe(false);
  });

  it('drops items with prompt shorter than 10 characters', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: 'Label 2', prompt: 'Short' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
    expect(result?.some((item) => item.prompt === 'Short')).toBe(false);
  });

  it('collapses whitespace in label and prompt before validation', () => {
    const input = JSON.stringify([
      { label: 'Label  \n\t  1', prompt: 'This   is   a   valid   prompt   text   here' },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result?.[0].label).toBe('Label 1');
    expect(result?.[0].prompt).toBe('This is a valid prompt text here');
  });

  it('drops items with empty label after whitespace collapse', () => {
    const input = JSON.stringify([
      { label: '  \n\t  ', prompt: 'This is a valid prompt text here' },
      { label: 'Label 1', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 2', prompt: 'Third prompt with enough characters' },
      { label: 'Label 3', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 4', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 5', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 6', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 7', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 8', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
  });

  it('drops items with empty prompt after whitespace collapse', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: '  \n\t  ' },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
  });

  it('returns first POOL_SIZE items when more than POOL_SIZE survive', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      label: `Label ${i + 1}`,
      prompt: `This is prompt number ${i + 1} with enough characters to pass validation`,
    }));
    const input = JSON.stringify(items);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(POOL_SIZE);
    expect(result?.[0].id).toBe('gen-0');
    expect(result?.[POOL_SIZE - 1].id).toBe('gen-8');
  });

  it('rejects non-string labels', () => {
    const input = JSON.stringify([
      { label: 123, prompt: 'This is a valid prompt text here' },
      { label: 'Label 1', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 2', prompt: 'Third prompt with enough characters' },
      { label: 'Label 3', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 4', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 5', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 6', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 7', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 8', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
  });

  it('rejects non-string prompts', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 123 },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(8);
  });

  it('generates correct sequential ids gen-0 through gen-8', () => {
    const input = JSON.stringify([
      { label: 'Label 1', prompt: 'This is a valid prompt text here' },
      { label: 'Label 2', prompt: 'Another prompt text for testing purposes' },
      { label: 'Label 3', prompt: 'Third prompt with enough characters' },
      { label: 'Label 4', prompt: 'Fourth prompt for the validation' },
      { label: 'Label 5', prompt: 'Fifth prompt is also valid here now' },
      { label: 'Label 6', prompt: 'Sixth prompt needs to be long enough' },
      { label: 'Label 7', prompt: 'Seventh prompt must be valid too' },
      { label: 'Label 8', prompt: 'Eighth prompt for the complete set' },
      { label: 'Label 9', prompt: 'Ninth prompt to complete the pool' },
    ]);
    const result = parseSuggestions(input);
    expect(result).not.toBe(null);
    for (let i = 0; i < POOL_SIZE; i++) {
      expect(result?.[i].id).toBe(`gen-${i}`);
    }
  });

  it('constants are exported correctly', () => {
    expect(POOL_SIZE).toBe(9);
    expect(MIN_ITEMS).toBe(6);
    expect(MAX_LABEL_CHARS).toBe(60);
    expect(MAX_PROMPT_CHARS).toBe(400);
  });
});
