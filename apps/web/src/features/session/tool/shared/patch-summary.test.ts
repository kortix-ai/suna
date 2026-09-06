import { describe, expect, test } from 'bun:test';
import { patchVerb } from './patch-summary';

describe('patchVerb', () => {
  test('four new files read as Wrote, not as Apply Patch', () => {
    // The exact regression: `apply_patch` creating four .txt files rendered
    // "Apply Patch 4 files · +4" under a code-file glyph.
    //
    // The verb is the WRITE verb, not a `create` of its own: producing a file
    // that was not there is a write, and `Created 4 files` here beside
    // `Wrote app.py` on a `write` row is one product using two words for one
    // act. The `create` ICON stays — the glyph still says the files are new.
    expect(patchVerb(['add', 'add', 'add', 'add'])).toEqual({
      verb: 'Wrote',
      running: 'Writing',
      // The third tense, shared with every other file row: a patch that failed
      // must not be reported in the wording of one that landed.
      failed: "Couldn't write",
      icon: 'create',
    });
  });

  test('every single-operation patch gets its own ordinary verb', () => {
    expect(patchVerb(['delete']).verb).toBe('Deleted');
    expect(patchVerb(['move']).verb).toBe('Renamed');
    expect(patchVerb(['update']).verb).toBe('Edited');
  });

  test('a mixed patch says Changed rather than inventing a shape', () => {
    // Creating one file and deleting another has no honest single verb.
    expect(patchVerb(['add', 'delete']).verb).toBe('Changed');
    expect(patchVerb(['update', 'add']).verb).toBe('Changed');
  });

  test('an unknown or missing type counts as an edit', () => {
    // Matches the per-file row, which falls back to `PATCH_TYPE_STYLE.update`.
    expect(patchVerb([undefined]).verb).toBe('Edited');
    expect(patchVerb(['something-else']).verb).toBe('Edited');
    expect(patchVerb(['update', undefined]).verb).toBe('Edited');
  });

  test('an empty patch — still streaming — is neutral, not a guess', () => {
    expect(patchVerb([]).verb).toBe('Changed');
  });

  test('the glyph follows the operation, never the file type', () => {
    expect(patchVerb(['add']).icon).toBe('create');
    expect(patchVerb(['delete']).icon).toBe('delete');
    expect(patchVerb(['update']).icon).toBe('edit');
    expect(patchVerb(['move']).icon).toBe('edit');
    expect(patchVerb(['add', 'delete']).icon).toBe('edit');
  });

  test('running forms are present participles for every case', () => {
    for (const types of [['add'], ['delete'], ['move'], ['update'], ['add', 'delete']]) {
      expect(patchVerb(types).running.endsWith('ing')).toBe(true);
    }
  });
});
