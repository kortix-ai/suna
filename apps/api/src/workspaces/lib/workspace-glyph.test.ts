/**
 * `normalizeWorkspaceGlyph` — the gate on `metadata.icon_glyph`.
 *
 * Runs on every write path AND on the read path (serializeWorkspace), so a row
 * hand-edited in the database to `{"name":"DROP TABLE","color":"red"}` still
 * normalizes to null before it can reach a React tree.
 */
import { describe, expect, test } from 'bun:test';
import { WORKSPACE_GLYPH_COLORS } from '@kortix/shared';
import { normalizeWorkspaceGlyph } from './workspace-glyph';

describe('normalizeWorkspaceGlyph — accepts', () => {
  test('a well-formed glyph', () => {
    expect(normalizeWorkspaceGlyph({ name: 'Rocket', color: 'blue' })).toEqual({
      name: 'Rocket',
      color: 'blue',
    });
  });

  test('every colour in the palette', () => {
    // Iterated from the catalogue rather than a hand-written array. A literal
    // list here would both drift from the palette silently and widen `color`
    // to `string`, which does not satisfy `WorkspaceGlyph`'s literal union —
    // `bun test` never noticed because it does not typecheck, but the API's
    // `tsc` gate did.
    for (const color of WORKSPACE_GLYPH_COLORS) {
      expect(normalizeWorkspaceGlyph({ name: 'Circle', color })).toEqual({ name: 'Circle', color });
    }
  });

  test('it drops unknown extra keys rather than storing them', () => {
    // Whatever reaches the column is what a future read trusts. Passing the
    // input object through would let a client write arbitrary jsonb.
    const result = normalizeWorkspaceGlyph({ name: 'Star', color: 'red', evil: 'payload' });
    expect(result).toEqual({ name: 'Star', color: 'red' });
    expect(Object.keys(result ?? {})).toEqual(['name', 'color']);
  });
});

describe('normalizeWorkspaceGlyph — rejects', () => {
  test('a name outside the catalogue', () => {
    // The renderer maps name -> component from a static registry. A name with
    // no component paints an empty tile, so it must be unstorable.
    expect(normalizeWorkspaceGlyph({ name: 'Skull', color: 'red' })).toBeNull();
  });

  test('a colour outside the palette', () => {
    expect(normalizeWorkspaceGlyph({ name: 'Rocket', color: 'chartreuse' })).toBeNull();
  });

  test('a missing half', () => {
    expect(normalizeWorkspaceGlyph({ name: 'Rocket' })).toBeNull();
    expect(normalizeWorkspaceGlyph({ color: 'blue' })).toBeNull();
  });

  test('non-objects', () => {
    expect(normalizeWorkspaceGlyph(null)).toBeNull();
    expect(normalizeWorkspaceGlyph(undefined)).toBeNull();
    expect(normalizeWorkspaceGlyph('Rocket')).toBeNull();
    expect(normalizeWorkspaceGlyph(42)).toBeNull();
    expect(normalizeWorkspaceGlyph(true)).toBeNull();
  });

  test('an array, which is typeof object', () => {
    // `typeof [] === 'object'`, so a bare typeof check would let this through
    // and then read `.name` as undefined.
    expect(normalizeWorkspaceGlyph(['Rocket', 'blue'])).toBeNull();

    // The case above passes with OR without the Array.isArray guard, because a
    // plain array has no own `name`/`color` and the type guards reject the
    // resulting undefineds. THIS one is what pins the guard: an array that does
    // carry both keys reaches the destructure intact, so only the isArray check
    // stops it. Not reachable through JSON.parse — no HTTP body or jsonb read
    // can produce own-keyed properties on an array — so the guard is
    // defence-in-depth, and this test is what documents that it is deliberate.
    const keyedArray = Object.assign(['x'], { name: 'Rocket', color: 'blue' });
    expect(normalizeWorkspaceGlyph(keyedArray)).toBeNull();
  });

  test('a nested-object name or colour', () => {
    expect(normalizeWorkspaceGlyph({ name: { toString: () => 'Rocket' }, color: 'blue' })).toBeNull();
  });

  test('case variants of a real name', () => {
    // The registry lookup is exact. Accepting 'rocket' here would store a value
    // that renders nothing.
    expect(normalizeWorkspaceGlyph({ name: 'rocket', color: 'blue' })).toBeNull();
    expect(normalizeWorkspaceGlyph({ name: 'ROCKET', color: 'blue' })).toBeNull();
  });

  test('a whitespace-padded name', () => {
    expect(normalizeWorkspaceGlyph({ name: ' Rocket ', color: 'blue' })).toBeNull();
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
      expect(() => normalizeWorkspaceGlyph(input)).not.toThrow();
    }
  });
});
