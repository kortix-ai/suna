/**
 * `normalizeProjectGlyph` — the gate on `metadata.icon_glyph`.
 *
 * Runs on every write path AND on the read path (serializeProject), so a row
 * hand-edited in the database to `{"name":"DROP TABLE","color":"red"}` still
 * normalizes to null before it can reach a React tree.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeProjectGlyph } from './project-glyph';

describe('normalizeProjectGlyph — accepts', () => {
  test('a well-formed glyph', () => {
    expect(normalizeProjectGlyph({ name: 'Rocket', color: 'blue' })).toEqual({
      name: 'Rocket',
      color: 'blue',
    });
  });

  test('every colour in the palette', () => {
    for (const color of ['grey', 'red', 'orange', 'yellow', 'lime', 'blue', 'purple', 'magenta']) {
      expect(normalizeProjectGlyph({ name: 'Circle', color })).toEqual({ name: 'Circle', color });
    }
  });

  test('it drops unknown extra keys rather than storing them', () => {
    // Whatever reaches the column is what a future read trusts. Passing the
    // input object through would let a client write arbitrary jsonb.
    const result = normalizeProjectGlyph({ name: 'Star', color: 'red', evil: 'payload' });
    expect(result).toEqual({ name: 'Star', color: 'red' });
    expect(Object.keys(result ?? {})).toEqual(['name', 'color']);
  });
});

describe('normalizeProjectGlyph — rejects', () => {
  test('a name outside the catalogue', () => {
    // The renderer maps name -> component from a static registry. A name with
    // no component paints an empty tile, so it must be unstorable.
    expect(normalizeProjectGlyph({ name: 'Skull', color: 'red' })).toBeNull();
  });

  test('a colour outside the palette', () => {
    expect(normalizeProjectGlyph({ name: 'Rocket', color: 'chartreuse' })).toBeNull();
  });

  test('a missing half', () => {
    expect(normalizeProjectGlyph({ name: 'Rocket' })).toBeNull();
    expect(normalizeProjectGlyph({ color: 'blue' })).toBeNull();
  });

  test('non-objects', () => {
    expect(normalizeProjectGlyph(null)).toBeNull();
    expect(normalizeProjectGlyph(undefined)).toBeNull();
    expect(normalizeProjectGlyph('Rocket')).toBeNull();
    expect(normalizeProjectGlyph(42)).toBeNull();
    expect(normalizeProjectGlyph(true)).toBeNull();
  });

  test('an array, which is typeof object', () => {
    // `typeof [] === 'object'`, so a bare typeof check would let this through
    // and then read `.name` as undefined.
    expect(normalizeProjectGlyph(['Rocket', 'blue'])).toBeNull();
  });

  test('a nested-object name or colour', () => {
    expect(normalizeProjectGlyph({ name: { toString: () => 'Rocket' }, color: 'blue' })).toBeNull();
  });

  test('case variants of a real name', () => {
    // The registry lookup is exact. Accepting 'rocket' here would store a value
    // that renders nothing.
    expect(normalizeProjectGlyph({ name: 'rocket', color: 'blue' })).toBeNull();
    expect(normalizeProjectGlyph({ name: 'ROCKET', color: 'blue' })).toBeNull();
  });

  test('a whitespace-padded name', () => {
    expect(normalizeProjectGlyph({ name: ' Rocket ', color: 'blue' })).toBeNull();
  });

  test('it never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      Object.create(null),
      {
        get name() {
          throw new Error('boom');
        },
        color: 'blue',
      },
      new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      ),
    ];
    for (const input of hostile) {
      expect(() => normalizeProjectGlyph(input)).not.toThrow();
    }
  });
});
