import { describe, expect, test } from 'bun:test';

import { parsePresentationOutput } from './presentation-helpers';

describe('parsePresentationOutput', () => {
  test('JSON output parses as-is', () => {
    expect(
      parsePresentationOutput('{"success":true,"action":"create_slide","slide_number":2}'),
    ).toEqual({ success: true, action: 'create_slide', slide_number: 2 });
  });

  test('a plain Error: string becomes a failed result', () => {
    expect(parsePresentationOutput('Error: deck not found')).toEqual({
      success: false,
      action: 'unknown',
      error: 'deck not found',
    });
  });

  test('anything else is null', () => {
    expect(parsePresentationOutput('')).toBeNull();
    expect(parsePresentationOutput('garbage')).toBeNull();
  });
});
