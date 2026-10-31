/**
 * The Claude subscription models as the model picker lists them: one group,
 * apart from the gateway's models, with whether the caller signed in.
 */
import {
  CLAUDE_AGENT_EFFORTS,
  CLAUDE_AGENT_MODELS,
  CLAUDE_AGENT_PROVIDER_ID,
  CLAUDE_AGENT_PROVIDER_NAME,
} from '@kortix/api-contract/claude-agent';
import { claudeLoginStatus } from '../../claude-subscription/store';

export async function claudeSubscriptionPickerGroup(accountId: string, userId: string) {
  const status = await claudeLoginStatus(accountId, userId).catch(() => null);
  const connected = Boolean(status?.connected && status.usable);
  return {
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    name: CLAUDE_AGENT_PROVIDER_NAME,
    connected,
    models: CLAUDE_AGENT_MODELS.map((model) => ({
      id: `${CLAUDE_AGENT_PROVIDER_ID}/${model.id}`,
      name: model.name,
      description: model.description,
      limit: { context: model.context, output: model.output },
      efforts: [...CLAUDE_AGENT_EFFORTS],
      requires: 'claude_subscription' as const,
      connected,
    })),
  };
}
