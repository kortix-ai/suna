import { expect, test } from 'bun:test';
import { artifactCommentPermissions } from './comment-permissions';

const viewer = { userId: 'person', sessionId: null, canComment: true, canEdit: false, manageAny: false };
const person = { userId: 'person', sessionId: null };
const other = { userId: 'other', sessionId: null };

test('current comment writers edit their own comments and moderators can delete others', () => {
  const rights = artifactCommentPermissions(viewer, person, null, false, false);
  expect(rights.can_reply).toBe(true);
  expect(rights.can_resolve).toBe(true);
  expect(rights.comment(person, false)).toEqual({ can_edit: true, can_delete: true });
  expect(rights.comment(other, false)).toEqual({ can_edit: false, can_delete: false });
  expect(artifactCommentPermissions({ ...viewer, manageAny: true }, other, null, false, false).comment(other, false)).toEqual({ can_edit: false, can_delete: true });
});

test('session authorship never gives a launcher the agent comment ownership', () => {
  const agent = { userId: null, sessionId: 'agent' };
  expect(artifactCommentPermissions(viewer, agent, null, false, false).comment(agent, false)).toEqual({ can_edit: false, can_delete: false });
  expect(artifactCommentPermissions({ ...viewer, sessionId: 'agent' }, other, 'agent', false, false).can_resolve).toBe(true);
});

test('historical snapshots, missing comment permission and deleted roots suppress every mutation', () => {
  for (const [read, deleted, historical] of [[{ ...viewer, canComment: false }, false, false], [viewer, true, false], [viewer, false, true]] as const) {
    const rights = artifactCommentPermissions(read, person, 'agent', deleted, historical);
    expect(rights.can_reply).toBe(false);
    expect(rights.can_resolve).toBe(false);
    expect(rights.comment(person, false)).toEqual({ can_edit: false, can_delete: false });
  }
});
