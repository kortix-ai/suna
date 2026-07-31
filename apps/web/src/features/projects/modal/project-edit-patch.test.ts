import { describe, expect, test } from 'bun:test';

import { buildProjectEditPatch, summarizeProjectEdit } from './project-edit-patch';

/** A project as the modal receives it: named, with an emoji already saved. */
const ICONED = { name: 'Atlas', icon: '🚀' };
/** A project that has never had an emoji. */
const PLAIN = { name: 'Atlas', icon: null };

/** The patch, or a readable failure naming the status that came back instead. */
function readyPatch(result: ReturnType<typeof buildProjectEditPatch>) {
  expect(result.status).toBe('ready');
  return result.status === 'ready' ? result.patch : {};
}

describe('nothing to save', () => {
  test('an untouched draft is unchanged', () => {
    expect(buildProjectEditPatch(ICONED, { name: 'Atlas', icon: '🚀' })).toEqual({
      status: 'unchanged',
    });
  });

  test('an untouched draft on a project with NO icon is unchanged', () => {
    // The stored icon is null and the draft is null. A diff that treated
    // "absent" and "null" as different would send `icon: null` on open+save
    // for every icon-less project.
    expect(buildProjectEditPatch(PLAIN, { name: 'Atlas', icon: null })).toEqual({
      status: 'unchanged',
    });
  });

  test('an undefined stored icon also compares equal to a null draft', () => {
    // `KortixProject.icon` is optional, so a response that simply omits the
    // member arrives as undefined, not null.
    expect(buildProjectEditPatch({ name: 'Atlas' }, { name: 'Atlas', icon: null })).toEqual({
      status: 'unchanged',
    });
  });

  test('surrounding whitespace on the name is not a change', () => {
    expect(buildProjectEditPatch(ICONED, { name: '  Atlas  ', icon: '🚀' })).toEqual({
      status: 'unchanged',
    });
  });

  test('a stored name with whitespace still compares equal', () => {
    expect(
      buildProjectEditPatch({ name: ' Atlas ', icon: null }, { name: 'Atlas', icon: null }),
    ).toEqual({
      status: 'unchanged',
    });
  });
});

describe('the name is required', () => {
  test('an emptied name is not savable', () => {
    expect(buildProjectEditPatch(ICONED, { name: '', icon: '🚀' })).toEqual({
      status: 'empty-name',
    });
  });

  test('a whitespace-only name is not savable', () => {
    expect(buildProjectEditPatch(ICONED, { name: '   ', icon: '🚀' })).toEqual({
      status: 'empty-name',
    });
  });

  test('an emptied name blocks the save even when the icon DID change', () => {
    // Otherwise the emoji would save and the empty name would be silently
    // dropped, leaving the modal reporting success for half the edit.
    expect(buildProjectEditPatch(ICONED, { name: '', icon: '🎯' })).toEqual({
      status: 'empty-name',
    });
  });
});

describe('renaming only', () => {
  test('the patch carries the new name and NO icon key at all', () => {
    // The load-bearing case. `PATCH` leaves the stored icon alone only when the
    // key is absent; `icon: null` would remove it and `icon: '🚀'` would be a
    // pointless rewrite of a value nobody touched.
    const patch = readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas 2', icon: '🚀' }));

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect('icon' in patch).toBe(false);
  });

  test('the name is trimmed before it is sent', () => {
    expect(readyPatch(buildProjectEditPatch(ICONED, { name: '  Atlas 2  ', icon: '🚀' }))).toEqual({
      name: 'Atlas 2',
    });
  });

  test('renaming a project with no icon still sends no icon key', () => {
    const patch = readyPatch(buildProjectEditPatch(PLAIN, { name: 'Atlas 2', icon: null }));

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect('icon' in patch).toBe(false);
  });
});

describe('changing the icon only', () => {
  test('a different emoji is savable on its own, with no name key', () => {
    // The bug this feature exists to fix: the old modal compared only the name,
    // so an icon-only edit left Save disabled.
    const patch = readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas', icon: '🎯' }));

    expect(patch).toEqual({ icon: '🎯' });
    expect('name' in patch).toBe(false);
  });

  test('adding a first emoji to a project that had none', () => {
    expect(readyPatch(buildProjectEditPatch(PLAIN, { name: 'Atlas', icon: '🎯' }))).toEqual({
      icon: '🎯',
    });
  });
});

describe('removing the icon', () => {
  test('the patch carries an explicit null, and the key is present', () => {
    const patch = readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas', icon: null }));

    // Both halves. `patch.icon === null` alone is satisfied by a MISSING key
    // under a loose comparison, and a present key alone says nothing about its
    // value. Only the pair distinguishes "remove it" from "leave it alone".
    expect('icon' in patch).toBe(true);
    expect(patch.icon).toBeNull();
    expect(patch).toEqual({ icon: null });
  });

  test('the null survives JSON serialization onto the wire', () => {
    // `JSON.stringify` drops `undefined` members silently. A patch built with
    // `icon: undefined` would look identical in a `toEqual` and arrive at the
    // API as an absent key — i.e. as "leave the icon alone".
    const patch = readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas', icon: null }));

    expect(JSON.stringify(patch)).toBe('{"icon":null}');
  });

  test('a rename and a removal travel in one patch', () => {
    const patch = readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas 2', icon: null }));

    expect(patch).toEqual({ name: 'Atlas 2', icon: null });
    expect(JSON.stringify(patch)).toContain('"icon":null');
  });
});

describe('changing both', () => {
  test('a rename and a new emoji travel in one patch', () => {
    expect(readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas 2', icon: '🎯' }))).toEqual({
      name: 'Atlas 2',
      icon: '🎯',
    });
  });
});

describe('summarizeProjectEdit', () => {
  test('a rename names the SERVER-returned name, not the draft', () => {
    // The server owns normalisation; telling the user what they typed would be
    // a lie the moment those two differ.
    expect(summarizeProjectEdit({ name: 'typed' }, 'Stored Name')).toBe('Renamed to "Stored Name"');
  });

  test('a rename is the headline when the icon moved too', () => {
    expect(summarizeProjectEdit({ name: 'Atlas 2', icon: '🎯' }, 'Atlas 2')).toBe(
      'Renamed to "Atlas 2"',
    );
  });

  test('an icon-only change says so, and does not claim a rename', () => {
    const message = summarizeProjectEdit({ icon: '🎯' }, 'Atlas');

    expect(message).toBe('Project icon updated');
    expect(message).not.toContain('Renamed');
  });

  test('a removal is reported as a removal, not as an update', () => {
    // The distinction the whole tri-state exists for. `!patch.icon` would
    // collapse these two branches and report a removal as an update.
    expect(summarizeProjectEdit({ icon: null }, 'Atlas')).toBe('Project icon removed');
  });

  test('an absent icon key is not treated as a removal', () => {
    // A rename-only patch has no `icon` member at all. Reading it as a removal
    // would tell the user their emoji is gone while it is still on the card.
    expect(summarizeProjectEdit({ name: 'Atlas 2' }, 'Atlas 2')).not.toContain('removed');
  });

  test('an empty patch still says something', () => {
    expect(summarizeProjectEdit({}, 'Atlas')).toBe('Project updated');
  });
});
