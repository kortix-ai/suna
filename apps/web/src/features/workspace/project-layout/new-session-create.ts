import type { ComposerOptions } from '@/features/session/composer-chat-input';
import type { SessionConnectorBindingsInput } from '@kortix/sdk';
import { isMetaAgentName, META_SANDBOX_SLUG } from '@kortix/shared';

export interface NewSessionCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
  connector_bindings?: SessionConnectorBindingsInput;
  inherit_unbound?: boolean;
  /** The subproject the session is started inside. Set only by the subproject
   *  page's composer; the project index composer never sends one. */
  subproject?: string;
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
  options: Pick<ComposerOptions, 'agent' | 'scope'> & {
    sandbox_slug?: string;
    subproject?: string;
  } = {},
): NewSessionCreateInput | undefined {
  const input: NewSessionCreateInput = {};
  // Before the agent/sandbox branches, because a subproject alone is enough to
  // need create overrides even when nothing else is picked.
  if (options.subproject) input.subproject = options.subproject;
  if (isMetaAgentName(options.agent)) {
    input.sandbox_slug = META_SANDBOX_SLUG;
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
