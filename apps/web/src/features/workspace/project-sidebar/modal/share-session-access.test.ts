import { describe, expect, test } from 'bun:test';

import {
  sessionAccessSummary,
  sessionAccessView,
  sessionOwnerName,
} from './share-session-access';

const session = (over: Record<string, unknown> = {}) =>
  ({
    is_owner: true,
    can_manage_sharing: true,
    owner_name: null,
    owner_email: null,
    visibility: 'private',
    sharing: { mode: 'private', ownerId: '' },
    ...over,
  }) as Parameters<typeof sessionAccessView>[0];

describe('sessionAccessView', () => {
  test('the creator edits everything', () => {
    const view = sessionAccessView(session());
    expect(view.role).toBe('owner');
    expect(view.canEdit).toBe(true);
    expect(view.disabledModes).toEqual([]);
  });

  test('someone the session was shared with reads it, never edits it', () => {
    const view = sessionAccessView(session({ is_owner: false, can_manage_sharing: false }));
    expect(view.role).toBe('viewer');
    expect(view.canEdit).toBe(false);
  });

  test('a manager governing a machine-owned session edits it but cannot pick "Only you"', () => {
    // "Only you" persists visibility=private, which means "the OWNER only". The
    // owner here is a service account, so saving it would lock the manager out
    // of a session they can no longer open to undo it.
    const view = sessionAccessView(session({ is_owner: false, can_manage_sharing: true }));
    expect(view.role).toBe('delegate');
    expect(view.canEdit).toBe(true);
    expect(view.disabledModes).toEqual(['private']);
  });

  test('an older payload with no is_owner/can_manage_sharing is treated as the owner', () => {
    const view = sessionAccessView(session({ is_owner: undefined, can_manage_sharing: undefined }));
    expect(view.role).toBe('owner');
    expect(view.canEdit).toBe(true);
  });
});

describe('sessionOwnerName', () => {
  test('the viewer reads as "You"', () => {
    expect(sessionOwnerName(session())).toBe('You');
  });

  test('a name wins over an email', () => {
    expect(
      sessionOwnerName(session({ is_owner: false, owner_name: 'Ada', owner_email: 'a@x.com' })),
    ).toBe('Ada');
  });

  test('an email stands in when there is no name', () => {
    expect(sessionOwnerName(session({ is_owner: false, owner_email: 'a@x.com' }))).toBe('a@x.com');
  });

  test('an unresolvable owner never renders as blank', () => {
    expect(sessionOwnerName(session({ is_owner: false }))).toBe('Another member');
  });
});

describe('sessionAccessSummary', () => {
  test('private, owned by the viewer', () => {
    expect(sessionAccessSummary(session())).toBe('Only you can open it.');
  });

  test('private, owned by somebody else', () => {
    expect(sessionAccessSummary(session({ is_owner: false, owner_name: 'Ada' }))).toBe(
      'Only Ada can open it.',
    );
  });

  test('project-wide', () => {
    expect(sessionAccessSummary(session({ visibility: 'project' }))).toBe(
      'Every member of this project can open it.',
    );
  });

  test('restricted counts members and groups, and singularizes', () => {
    expect(
      sessionAccessSummary(
        session({
          visibility: 'restricted',
          sharing: { mode: 'members', memberIds: ['a'], groupIds: ['g1', 'g2'] },
        }),
      ),
    ).toBe('You and 1 member and 2 groups can open it.');
  });

  test('restricted with only members omits the group clause', () => {
    expect(
      sessionAccessSummary(
        session({
          is_owner: false,
          owner_name: 'Ada',
          visibility: 'restricted',
          sharing: { mode: 'members', memberIds: ['a', 'b'], groupIds: [] },
        }),
      ),
    ).toBe('Ada and 2 members can open it.');
  });
});
