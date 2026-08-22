import type { Agent } from '@kortix/sdk/react';

/**
 * Which agent the composer will actually run, given the roster the server is
 * willing to hand this user.
 *
 * Project agents are deny-by-default for a `member`: the roster only contains
 * agents an explicit `iam_resource_grant` names them (or one of their groups)
 * on. Two consequences the composer has to render honestly, and used not to:
 *
 *   - The roster can be legitimately EMPTY. The picker was hidden entirely in
 *     that case (`agents.length > 0` in `ComposerUnderbar`), the send button
 *     stayed live, and the prompt went out with no `agent` option — so the
 *     server silently fell back to the manifest `default_agent` (`kortix`) and
 *     the user watched a run they never picked an agent for. For a member with
 *     no grant that same send is a 403.
 *   - The project's `default_agent` may not be in it. The picker then showed
 *     nothing rather than the agent that would run.
 *
 * This resolver is the single answer to "what is selected, and can we send" —
 * pure, so both hosts (`ComposerChatInput` and `session-chat.tsx`) get the same
 * answer and it is testable without a DOM or a network.
 */

/** The refusal, as a toast title. */
export const NO_AGENT_ACCESS_LABEL = 'No agents available to you';
/** The secondary line: what the user can do about it. */
export const NO_AGENT_ACCESS_HINT = 'Ask a manager for access';
/**
 * The one-line form, for the tooltip on the picker and on the send button.
 *
 * The state itself is carried by the controls looking disabled — a muted
 * trigger beside a dead send button — not by a banner or a coloured pill
 * shouting it across the composer. The words live in the tooltip, where the
 * user goes when they want to know why.
 */
export const NO_AGENT_ACCESS_MESSAGE = 'No agents available to you — ask a manager for access';

export type ComposerAgentReason =
  /** The roster has not loaded yet — nothing is refused on a pending query. */
  | 'loading'
  /** The caller's own pick is accessible and stands. */
  | 'selected'
  /** No pick; the session's immutable creation agent stands. */
  | 'bound'
  /** No pick (or an inaccessible one); the project default is accessible. */
  | 'default'
  /** Neither the pick nor the default is accessible; first grant wins. */
  | 'first_accessible'
  /** Nothing is accessible. The composer must refuse the send. */
  | 'no_access';

export interface ComposerAgentResolution {
  /** The agent name to display AND to send. `null` only when nothing runs. */
  selected: string | null;
  /** No agent can run: disable the picker and the send control. */
  disabled: boolean;
  reason: ComposerAgentReason;
}

/**
 * The agents a composer may offer: visible, and not a subagent.
 *
 * Subagents are dispatched BY an agent, never picked as the one to prompt, and
 * `AgentSelector` has always filtered them out of the list. They are filtered
 * here too so "the roster is empty" means the same thing to the resolver as it
 * does to the control that renders it — a roster of nothing but subagents is an
 * empty picker, and must not read as "we have an agent to run".
 */
export function composerSelectableAgents(agents: Agent[] | undefined): Agent[] {
  if (!Array.isArray(agents)) return [];
  return agents.filter((a) => !a.hidden && a.mode !== 'subagent');
}

export function resolveComposerAgent(input: {
  /** The accessible roster. `undefined` means the query is still in flight. */
  agents: Agent[] | undefined;
  /**
   * The session's immutable creation agent, when this composer belongs to an
   * existing project session. It is what the server RUNS for this session
   * regardless of roster membership, so with no explicit pick it is the truth
   * to display — never `selectable[0]`, which is somebody else's first grant
   * and made a booting Kortix session read "Meta" until the runtime corrected
   * it.
   */
  boundAgent?: string | null;
  /** The project's declared default agent, accessible or not. */
  defaultAgent?: string | null;
  /** The caller's current pick (session slot, last-used, …), if any. */
  selectedAgent?: string | null;
}): ComposerAgentResolution {
  const bound = input.boundAgent?.trim() || null;
  // A pending roster is not an empty one. Refusing the send here would disable
  // the composer on every cold mount for a beat, which reads as broken. Show
  // the pick, else the session's bound agent — the one name known to be right
  // before any query lands.
  if (!Array.isArray(input.agents)) {
    const picked = input.selectedAgent?.trim();
    if (picked) return { selected: picked, disabled: false, reason: 'loading' };
    return { selected: bound, disabled: false, reason: 'loading' };
  }

  const selectable = composerSelectableAgents(input.agents);
  if (selectable.length === 0) {
    // A bound session still runs its own agent server-side; an empty roster
    // refuses only unbound composers.
    if (bound) return { selected: bound, disabled: false, reason: 'bound' };
    return { selected: null, disabled: true, reason: 'no_access' };
  }

  const picked = input.selectedAgent?.trim();
  if (picked && selectable.some((a) => a.name === picked)) {
    return { selected: picked, disabled: false, reason: 'selected' };
  }

  // No pick: the session's own agent outranks the project default — an
  // existing session must never re-prompt under a different agent than the
  // one it was created with just because a default or grant order says so.
  if (bound) {
    return { selected: bound, disabled: false, reason: 'bound' };
  }

  const declaredDefault = input.defaultAgent?.trim();
  if (declaredDefault && selectable.some((a) => a.name === declaredDefault)) {
    return { selected: declaredDefault, disabled: false, reason: 'default' };
  }

  // The default is not ours to run. Pre-select the first agent we DO have, so
  // the picker shows the agent that will actually run and the same name is
  // what the send carries.
  return { selected: selectable[0].name, disabled: false, reason: 'first_accessible' };
}
