/**
 * Which agent the composer will actually run — the rules now live in the
 * framework-free SDK core (`resolveComposerAgent`, `composerSelectableAgents`
 * from `@kortix/sdk`) so web and mobile resolve the same agent. This file keeps
 * web's user-facing copy for the no-access state and re-exports the resolver
 * for the existing importers.
 */
export {
  composerSelectableAgents,
  resolveComposerAgent,
  type ComposerAgentReason,
  type ComposerAgentResolution,
} from '@kortix/sdk';

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
