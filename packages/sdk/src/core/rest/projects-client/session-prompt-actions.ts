import type { SessionPrompt } from './sessions';

/** Who is looking at a waiting prompt. */
export interface SessionPromptViewer {
  /** The signed-in user's id. Unknown (`null`/`undefined`) reads every prompt
   *  as the viewer's own, as before the API listed authors. */
  userId: string | null | undefined;
  /** The viewer may stop, restart or delete this session: the session row's
   *  `can_manage_lifecycle`. */
  managesSession?: boolean;
}

/** What a viewer may do to one waiting prompt. The API enforces the same rule. */
export interface SessionPromptActions {
  /** The viewer sent it. Edit, send now, retry and Stop and send are the
   *  author's only: the prompt runs as its author, with their role, budget
   *  and connections. */
  own: boolean;
  /** The viewer may remove it: its author, or someone who manages the session. */
  removable: boolean;
}

/**
 * What `viewer` may do to `prompt` in a session that several members prompt.
 *
 * A prompt without the `author_user_id` field (an API built before authors
 * were listed) reads as the viewer's own, so the row keeps the controls it
 * had. `null` is the API saying no sender was recorded: the prompt is nobody's
 * own. The API answers `403 not_prompt_author` to a write that is not allowed.
 */
export function sessionPromptActions(
  prompt: Pick<SessionPrompt, 'author_user_id'>,
  viewer: SessionPromptViewer,
): SessionPromptActions {
  const own =
    prompt.author_user_id === undefined || !viewer.userId || prompt.author_user_id === viewer.userId;
  return { own, removable: own || viewer.managesSession === true };
}
