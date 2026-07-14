import type { ComposerOptions } from '@/features/session/composer-chat-input';

export interface NewSessionCreateInput {
  sandbox_slug?: string;
  base_ref?: string;
  agent_name?: string;
  connection_id?: import('@kortix/sdk').HarnessAuthKind;
  model_selection?: {
    kind: 'default' | 'preset' | 'custom';
    model_id?: string | null;
    connection_id?: import('@kortix/sdk').HarnessAuthKind | null;
  };
}

export interface NewSessionAgentConfig {
  runtime_default_agent: string | null;
  agents: Array<{ name: string; enabled?: boolean }>;
}

/** Resolve the concrete immutable agent binding for a new session. */
export function resolveNewSessionAgent(
  config: NewSessionAgentConfig | null | undefined,
  requested?: string | null,
): string | undefined {
  const picked = requested?.trim();
  if (picked) return picked;
  const configured = config?.runtime_default_agent?.trim();
  if (configured) return configured;
  return config?.agents.find((agent) => agent.enabled !== false && agent.name.trim())?.name;
}

/**
 * Build the session-create payload from the composer's send options.
 *
 * A project session's boot agent is immutable and bound at creation. The ACP
 * daemon compiles that agent's harness, auth, and model launch plan once for the
 * session, so the composer selection must be carried into the create request.
 *
 * `agent_name` therefore mirrors `options.agent` exactly: the create-time bind
 * and the first-prompt send read the same value, so they can never disagree.
 *
 * Returns `undefined` when there is nothing to bind (sandbox stays default and
 * no agent was picked), so callers can omit the create overrides entirely.
 */
export function buildNewSessionCreateInput(
  options: Pick<ComposerOptions, 'agent' | 'runtimeModel' | 'connectionId' | 'modelSelection'> & {
    sandbox_slug?: string;
    base_ref?: string;
  } = {},
): NewSessionCreateInput | undefined {
  const input: NewSessionCreateInput = {};
  if (options.sandbox_slug) input.sandbox_slug = options.sandbox_slug;
  if (options.base_ref) input.base_ref = options.base_ref;
  if (options.agent) input.agent_name = options.agent;
  if (options.connectionId) input.connection_id = options.connectionId;
  if (options.modelSelection) {
    input.model_selection = {
      kind: options.modelSelection.kind,
      model_id: options.modelSelection.modelId ?? null,
      connection_id: options.modelSelection.connectionId ?? options.connectionId ?? null,
    };
  } else if (options.runtimeModel?.trim()) {
    input.model_selection = {
      kind: 'custom',
      model_id: options.runtimeModel.trim(),
      connection_id: options.connectionId ?? null,
    };
  }
  return Object.keys(input).length > 0 ? input : undefined;
}
