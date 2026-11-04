/**
 * Model refs of the `claude-agent` provider: Claude models on the session
 * person's own Claude subscription (`@kortix/api-contract/claude-agent`).
 *
 * Claude Code in the box makes these model calls straight to Anthropic. The
 * LLM gateway never serves them, so they skip its servability probe, its
 * credit admission and the managed-model lineup. A ref is `claude-agent/<id>`
 * and is stored and booted as-is (`KORTIX_MODEL=claude-agent/<id>`).
 */
import {
  CLAUDE_AGENT_MODELS,
  CLAUDE_AGENT_PROVIDER_ID,
  claudeAgentModelId,
} from '@kortix/api-contract/claude-agent';

export { isClaudeAgentModelRef } from '@kortix/api-contract/claude-agent';

export type ClaudeAgentRefCheck =
  | { kind: 'none' }
  | { kind: 'valid'; ref: string }
  | { kind: 'invalid'; message: string };

const VALID_REFS = CLAUDE_AGENT_MODELS.map((model) => `${CLAUDE_AGENT_PROVIDER_ID}/${model.id}`);

/** `none`: another provider's ref. `invalid`: a `claude-agent/` ref with an unknown id. */
export function checkClaudeAgentRef(ref: string | null | undefined): ClaudeAgentRefCheck {
  const trimmed = (ref ?? '').trim();
  if (!trimmed.startsWith(`${CLAUDE_AGENT_PROVIDER_ID}/`)) return { kind: 'none' };
  const id = claudeAgentModelId(trimmed);
  if (id && CLAUDE_AGENT_MODELS.some((model) => model.id === id)) return { kind: 'valid', ref: `${CLAUDE_AGENT_PROVIDER_ID}/${id}` };
  return {
    kind: 'invalid',
    message: `"${trimmed}" is not a Claude subscription model. Use one of: ${VALID_REFS.join(', ')}.`,
  };
}

export const CLAUDE_SUBSCRIPTION_REQUIRED = 'claude_subscription_required' as const;
export const CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE = 'Connect your Claude subscription to use Claude models.';

/**
 * The 409 body of a turn on a Claude subscription model whose prompting person
 * has no Claude login. `code` is what a client branches on (a Connect button).
 */
export function claudeSubscriptionRequiredBody(model: string) {
  return {
    error: CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE,
    message: CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE,
    code: CLAUDE_SUBSCRIPTION_REQUIRED,
    provider_id: CLAUDE_AGENT_PROVIDER_ID,
    model,
  };
}
