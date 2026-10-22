import { describe, expect, test } from 'bun:test';
import { sessionPromptActions } from './session-prompt-actions';

const AUTHOR = 'user-author';
const OTHER = 'user-other';

describe('sessionPromptActions', () => {
  test("the author's own prompt: every action", () => {
    expect(sessionPromptActions({ author_user_id: AUTHOR }, { userId: AUTHOR })).toEqual({
      own: true,
      removable: true,
    });
  });

  // The API answers 403 not_prompt_author to edit, send now, retry and
  // Stop and send from anyone else: the row runs as its author.
  test("another member's prompt: nothing", () => {
    expect(sessionPromptActions({ author_user_id: AUTHOR }, { userId: OTHER })).toEqual({
      own: false,
      removable: false,
    });
  });

  // Someone who may stop or delete the whole session (`can_manage_lifecycle`)
  // may also remove one waiting prompt from it, and nothing else.
  test("another member's prompt, viewer manages the session: remove only", () => {
    expect(
      sessionPromptActions({ author_user_id: AUTHOR }, { userId: OTHER, managesSession: true }),
    ).toEqual({ own: false, removable: true });
  });

  // An API built before authors were listed, or a viewer whose id is not
  // known yet: the row keeps the actions it had. The API still decides.
  test('an older API (no author field) or no viewer id: the row reads as the viewer’s own', () => {
    expect(sessionPromptActions({}, { userId: OTHER })).toEqual({ own: true, removable: true });
    expect(sessionPromptActions({ author_user_id: AUTHOR }, { userId: null })).toEqual({
      own: true,
      removable: true,
    });
  });

  // `null` is the API saying the prompt has no recorded sender. It runs as
  // nobody the viewer is, so the API refuses every write but a manager's remove.
  test('a prompt with no recorded sender: remove for a session manager only', () => {
    expect(sessionPromptActions({ author_user_id: null }, { userId: OTHER })).toEqual({
      own: false,
      removable: false,
    });
    expect(
      sessionPromptActions({ author_user_id: null }, { userId: OTHER, managesSession: true }),
    ).toEqual({ own: false, removable: true });
  });
});
