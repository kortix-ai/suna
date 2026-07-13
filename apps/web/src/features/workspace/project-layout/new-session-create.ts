import type { ComposerOptions } from '@/features/session/composer-chat-input';

export interface NewSessionCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
}

/**
 * Build the session-create payload from the composer's send options.
 *
 * A project session's boot agent is IMMUTABLE and bound at creation. The API
 * preview proxy rejects any prompt whose `agent` differs from the session's
 * bound agent with 409 AGENT_SWITCH_REQUIRES_NEW_SESSION — and the bound agent
 * defaults to "default" when none is set at create. So the agent the composer
 * will send on the very first prompt MUST be bound here, at session birth, or
 * the first message fails to start the task at all.
 *
 * `agent_name` therefore mirrors `options.agent` exactly: the create-time bind
 * and the first-prompt send read the same value, so they can never disagree.
 *
 * Returns `undefined` when there is nothing to bind (sandbox stays default and
 * no agent was picked), so callers can omit the create overrides entirely.
 */
export function buildNewSessionCreateInput(
  options: Pick<ComposerOptions, 'agent'> & { sandbox_slug?: string } = {},
): NewSessionCreateInput | undefined {
  const input: NewSessionCreateInput = {};
  if (options.sandbox_slug) input.sandbox_slug = options.sandbox_slug;
  if (options.agent) input.agent_name = options.agent;
  return Object.keys(input).length > 0 ? input : undefined;
}
