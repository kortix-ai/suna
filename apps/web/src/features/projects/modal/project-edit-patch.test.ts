import { describe, expect, test } from 'bun:test';

import { buildProjectEditPatch, summarizeProjectEdit } from './project-edit-patch';

/** A project as the modal receives it: named, with an emoji already saved. */
const ICONED = { name: 'Atlas', icon: '🚀' };
/** A project that has never had an icon of either kind. */
const PLAIN = { name: 'Atlas', icon: null };
/** A project with a glyph already saved (never an emoji at the same time —
 *  the server-side invariant this feature exists to preserve). */
const GLYPHED = { name: 'Atlas', icon_glyph: { name: 'Rocket', color: 'blue' } };

/** The patch, or a readable failure naming the status that came back instead. */
function readyPatch(result: ReturnType<typeof buildProjectEditPatch>) {
  expect(result.status).toBe('ready');
  return result.status === 'ready' ? result.patch : {};
}

describe('nothing to save', () => {
  test('an untouched draft is unchanged', () => {
    expect(buildProjectEditPatch(ICONED, { name: 'Atlas', icon: { emoji: '🚀' } })).toEqual({
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

  test('an untouched GLYPH draft is unchanged too', () => {
    expect(
      buildProjectEditPatch(GLYPHED, {
        name: 'Atlas',
        icon: { glyph: { name: 'Rocket', color: 'blue' } },
      }),
    ).toEqual({ status: 'unchanged' });
  });

  test('surrounding whitespace on the name is not a change', () => {
    expect(buildProjectEditPatch(ICONED, { name: '  Atlas  ', icon: { emoji: '🚀' } })).toEqual({
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
    expect(buildProjectEditPatch(ICONED, { name: '', icon: { emoji: '🚀' } })).toEqual({
      status: 'empty-name',
    });
  });

  test('a whitespace-only name is not savable', () => {
    expect(buildProjectEditPatch(ICONED, { name: '   ', icon: { emoji: '🚀' } })).toEqual({
      status: 'empty-name',
    });
  });

  test('an emptied name blocks the save even when the icon DID change', () => {
    // Otherwise the icon would save and the empty name would be silently
    // dropped, leaving the modal reporting success for half the edit.
    expect(buildProjectEditPatch(ICONED, { name: '', icon: { emoji: '🎯' } })).toEqual({
      status: 'empty-name',
    });
  });
});

describe('renaming only', () => {
  test('the patch carries the new name and NO icon key at all', () => {
    // The load-bearing case. `PATCH` leaves the stored icon alone only when the
    // key is absent; `icon: null` would remove it and `icon: '🚀'` would be a
    // pointless rewrite of a value nobody touched.
    const patch = readyPatch(
      buildProjectEditPatch(ICONED, { name: 'Atlas 2', icon: { emoji: '🚀' } }),
    );

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect('icon' in patch).toBe(false);
    expect('icon_glyph' in patch).toBe(false);
  });

  test('the name is trimmed before it is sent', () => {
    expect(
      readyPatch(buildProjectEditPatch(ICONED, { name: '  Atlas 2  ', icon: { emoji: '🚀' } })),
    ).toEqual({ name: 'Atlas 2' });
  });

  test('renaming a project with no icon still sends no icon key', () => {
    const patch = readyPatch(buildProjectEditPatch(PLAIN, { name: 'Atlas 2', icon: null }));

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect('icon' in patch).toBe(false);
  });

  test('renaming a GLYPH project sends no icon_glyph key', () => {
    const patch = readyPatch(
      buildProjectEditPatch(GLYPHED, {
        name: 'Atlas 2',
        icon: { glyph: { name: 'Rocket', color: 'blue' } },
      }),
    );

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect('icon_glyph' in patch).toBe(false);
    expect('icon' in patch).toBe(false);
  });
});

describe('changing the icon only', () => {
  test('a different emoji is savable on its own, with no name key', () => {
    // The bug this feature exists to fix: the old modal compared only the name,
    // so an icon-only edit left Save disabled.
    const patch = readyPatch(
      buildProjectEditPatch(ICONED, { name: 'Atlas', icon: { emoji: '🎯' } }),
    );

    expect(patch).toEqual({ icon: '🎯' });
    expect('name' in patch).toBe(false);
    expect('icon_glyph' in patch).toBe(false);
  });

  test('adding a first emoji to a project that had none', () => {
    expect(
      readyPatch(buildProjectEditPatch(PLAIN, { name: 'Atlas', icon: { emoji: '🎯' } })),
    ).toEqual({ icon: '🎯' });
  });

  test('a different glyph colour is savable on its own', () => {
    const patch = readyPatch(
      buildProjectEditPatch(GLYPHED, {
        name: 'Atlas',
        icon: { glyph: { name: 'Rocket', color: 'magenta' } },
      }),
    );

    expect(patch).toEqual({ icon_glyph: { name: 'Rocket', color: 'magenta' } });
    expect('name' in patch).toBe(false);
    expect('icon' in patch).toBe(false);
  });

  test('a different glyph NAME in the same colour still counts as a change', () => {
    const patch = readyPatch(
      buildProjectEditPatch(GLYPHED, {
        name: 'Atlas',
        icon: { glyph: { name: 'Star', color: 'blue' } },
      }),
    );

    expect(patch).toEqual({ icon_glyph: { name: 'Star', color: 'blue' } });
  });

  test('adding a first glyph to a project that had none', () => {
    expect(
      readyPatch(
        buildProjectEditPatch(PLAIN, {
          name: 'Atlas',
          icon: { glyph: { name: 'Rocket', color: 'blue' } },
        }),
      ),
    ).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
  });
});

describe('switching between an emoji and a glyph', () => {
  test('switching an emoji project to a glyph sends icon_glyph, and NEVER icon: null', () => {
    // The case the server-side invariant hinges on: the API deletes the
    // stored emoji itself the instant `icon_glyph` is written, so a patch
    // that ALSO carried `icon: null` would be redundant at best — and if this
    // client ever tracked icon/glyph as two independent nullable fields
    // instead of one union draft, it is exactly the patch a naive diff would
    // produce.
    const patch = readyPatch(
      buildProjectEditPatch(ICONED, {
        name: 'Atlas',
        icon: { glyph: { name: 'Rocket', color: 'blue' } },
      }),
    );

    expect(patch).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect('icon' in patch).toBe(false);
  });

  test('switching a glyph project to an emoji sends icon, and NEVER icon_glyph: null', () => {
    // The symmetric direction — same server behaviour, same reasoning,
    // covered independently because the two branches are separate code paths.
    const patch = readyPatch(
      buildProjectEditPatch(GLYPHED, { name: 'Atlas', icon: { emoji: '🚀' } }),
    );

    expect(patch).toEqual({ icon: '🚀' });
    expect('icon_glyph' in patch).toBe(false);
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

  test('clearing a GLYPH project sends icon_glyph: null, and NEVER icon: null', () => {
    // The other half of "glyph cleared": nothing was ever stored under
    // `icon` for this project, so it must not appear in the patch at all —
    // only the key that actually held a value gets the explicit clear.
    const patch = readyPatch(buildProjectEditPatch(GLYPHED, { name: 'Atlas', icon: null }));

    expect(patch).toEqual({ icon_glyph: null });
    expect('icon' in patch).toBe(false);
    expect(JSON.stringify(patch)).toBe('{"icon_glyph":null}');
  });

  test('clearing an already-empty project is a no-op, not a spurious clear', () => {
    expect(buildProjectEditPatch(PLAIN, { name: 'Atlas', icon: null })).toEqual({
      status: 'unchanged',
    });
  });
});

describe('changing both', () => {
  test('a rename and a new emoji travel in one patch', () => {
    expect(
      readyPatch(buildProjectEditPatch(ICONED, { name: 'Atlas 2', icon: { emoji: '🎯' } })),
    ).toEqual({
      name: 'Atlas 2',
      icon: '🎯',
    });
  });

  test('a rename and a new glyph travel in one patch', () => {
    expect(
      readyPatch(
        buildProjectEditPatch(GLYPHED, {
          name: 'Atlas 2',
          icon: { glyph: { name: 'Star', color: 'red' } },
        }),
      ),
    ).toEqual({
      name: 'Atlas 2',
      icon_glyph: { name: 'Star', color: 'red' },
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

    expect(message).toBe('Workspace icon updated');
    expect(message).not.toContain('Renamed');
  });

  test('a glyph-only change says so too', () => {
    const message = summarizeProjectEdit(
      { icon_glyph: { name: 'Rocket', color: 'blue' } },
      'Atlas',
    );

    expect(message).toBe('Workspace icon updated');
  });

  test('a removal is reported as a removal, not as an update', () => {
    // The distinction the whole tri-state exists for. `!patch.icon` would
    // collapse these two branches and report a removal as an update.
    expect(summarizeProjectEdit({ icon: null }, 'Atlas')).toBe('Workspace icon removed');
  });

  test('a glyph removal is reported as a removal too', () => {
    expect(summarizeProjectEdit({ icon_glyph: null }, 'Atlas')).toBe('Workspace icon removed');
  });

  test('an absent icon key is not treated as a removal', () => {
    // A rename-only patch has no `icon` member at all. Reading it as a removal
    // would tell the user their icon is gone while it is still on the card.
    expect(summarizeProjectEdit({ name: 'Atlas 2' }, 'Atlas 2')).not.toContain('removed');
  });

  test('an empty patch still says something', () => {
    expect(summarizeProjectEdit({}, 'Atlas')).toBe('Workspace updated');
  });
});
