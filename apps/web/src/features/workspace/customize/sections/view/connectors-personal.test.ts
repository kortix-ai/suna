import { describe, expect, test } from 'bun:test';
import { prunePersonalConnectors } from './connectors-personal';

describe('prunePersonalConnectors', () => {
  test('keeps entries that are still granted', () => {
    expect(prunePersonalConnectors(['gmail'], ['gmail', 'slack'])).toEqual(['gmail']);
  });

  test('drops an entry whose grant was just removed', () => {
    // The exact failure this guards: leaving `slack` personal-but-ungranted
    // writes an agent block the manifest parser refuses, which breaks
    // session-create for that agent.
    expect(prunePersonalConnectors(['gmail', 'slack'], ['gmail'])).toEqual(['gmail']);
  });

  test("an 'all' grant keeps everything", () => {
    expect(prunePersonalConnectors(['gmail', 'slack'], 'all')).toEqual(['gmail', 'slack']);
  });

  test('clearing the grant clears the personal set', () => {
    expect(prunePersonalConnectors(['gmail'], 'none')).toBeUndefined();
    expect(prunePersonalConnectors(['gmail'], [])).toBeUndefined();
    expect(prunePersonalConnectors(['gmail'], undefined)).toBeUndefined();
  });

  test('returns undefined (not []) so the key is omitted from the YAML', () => {
    expect(prunePersonalConnectors(['slack'], ['gmail'])).toBeUndefined();
    expect(prunePersonalConnectors([], ['gmail'])).toBeUndefined();
    expect(prunePersonalConnectors(undefined, ['gmail'])).toBeUndefined();
  });
});
