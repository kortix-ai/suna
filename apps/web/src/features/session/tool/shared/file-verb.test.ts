import { describe, expect, test } from 'bun:test';

import { FILE_VERBS, fileVerb, filePhase } from './file-verb';

describe('fileVerb — one vocabulary for every row that touches a file', () => {
  test('a running call is a present participle, a settled one is past tense', () => {
    expect(fileVerb('write', 'running')).toBe('Writing');
    expect(fileVerb('write', 'done')).toBe('Wrote');
    expect(fileVerb('edit', 'running')).toBe('Editing');
    expect(fileVerb('edit', 'done')).toBe('Edited');
  });

  test('a failed call never wears the wording of one that landed', () => {
    // The panel's rule (W7, `group-steps.ts`) reaching the trigger rows: the
    // icon already flipped to a warning, the words used to keep claiming success.
    expect(fileVerb('write', 'failed')).toBe("Couldn't write");
    expect(fileVerb('edit', 'failed')).toBe("Couldn't update");
  });

  test('the failed wording matches narration.ts character for character', () => {
    // `narration.ts:805` picks "write" for a write and "update" for an edit.
    // Two surfaces describing one failure must not pick two different words.
    expect(FILE_VERBS.write.failed).toBe("Couldn't write");
    expect(FILE_VERBS.edit.failed).toBe("Couldn't update");
  });

  test('the read-only rows join the same table', () => {
    // `List` was the bare registry key; `Read` was a past tense a streaming
    // call had not earned. Neither mutates a file, both had the same defect.
    expect(fileVerb('list', 'running')).toBe('Listing');
    expect(fileVerb('list', 'done')).toBe('Listed');
    expect(fileVerb('read', 'running')).toBe('Reading');
    expect(fileVerb('read', 'done')).toBe('Read');
  });

  test('every action carries all three tenses — none can be forgotten', () => {
    for (const [action, verbs] of Object.entries(FILE_VERBS)) {
      expect(verbs.verb, action).toBeTruthy();
      expect(verbs.running, action).toBeTruthy();
      expect(verbs.failed, action).toBeTruthy();
    }
  });
});

describe('filePhase — the tense a row is in', () => {
  test('an error outranks the run state: a failing call is not "still going"', () => {
    expect(filePhase(true, true)).toBe('failed');
    expect(filePhase(false, true)).toBe('failed');
  });

  test('a live turn is present tense, a finished one is past', () => {
    expect(filePhase(true, false)).toBe('running');
    expect(filePhase(false, false)).toBe('done');
  });
});
