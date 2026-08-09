import type { ComposerOptions } from '@/features/session/composer-chat-input';
import type { SessionConnectorBindingsInput } from '@kortix/sdk';
import { isAgiAgentName, AGI_SANDBOX_SLUG } from '@kortix/shared';

export interface NewSessionCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
  connector_bindings?: SessionConnectorBindingsInput;
  inherit_unbound?: boolean;
}

/**
 * Build the session-create payload from the composer's send options.
 *
 * A project session chooses its boot agent at creation. The first prompt uses
 * the same agent so initial provisioning applies the intended grants. Later
 * prompts can switch agents after server-side re-scoping. The boot agent
 * defaults to "default" when none is set at create.
 *
 * `agent_name` therefore mirrors `options.agent` exactly: the create-time bind
 * and the first-prompt send read the same value, so they can never disagree.
 *
 * Returns `undefined` when there is nothing to bind (sandbox stays default and
 * no agent was picked), so callers can omit the create overrides entirely.
 */
export function buildNewSessionCreateInput(
  options: Pick<ComposerOptions, 'agent' | 'scope'> & { sandbox_slug?: string } = {},
): NewSessionCreateInput | undefined {
  const input: NewSessionCreateInput = {};
  if (isAgiAgentName(options.agent)) {
    input.sandbox_slug = AGI_SANDBOX_SLUG;
  } else if (options.sandbox_slug) {
    input.sandbox_slug = options.sandbox_slug;
  }
  if (options.agent) input.agent_name = options.agent;
  if (
    options.scope?.availability.connector_bindings &&
    options.scope.draft.connector_bindings !== undefined &&
    options.scope.draft.connector_bindings_inherited !== true
  ) {
    input.connector_bindings = Object.fromEntries(
      Object.entries(options.scope.draft.connector_bindings).map(([alias, binding]) => [
        alias,
        {
          connection_id: binding.connection_id,
        },
      ]),
    );
    input.inherit_unbound = false;
  }
  return Object.keys(input).length > 0 ? input : undefined;
}
