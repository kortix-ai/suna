/**
 * The Claude subscription models as the model picker lists them: one group,
 * apart from the gateway's models. `connected`: the caller may use at least one
 * Claude account in this project (their own or one shared with them).
 * `enabled`: the project's model settings allow the model; on by default.
 */
import {
  CLAUDE_AGENT_EFFORTS,
  CLAUDE_AGENT_MODELS,
  CLAUDE_AGENT_PROVIDER_ID,
  CLAUDE_AGENT_PROVIDER_NAME,
} from '@kortix/api-contract/claude-agent';
import { countUsableClaudeAccounts } from '../../claude-subscription/accounts';
import { modelAccessAllows, type ProjectModelAccess } from '../../llm-gateway/model-access';

export async function claudeSubscriptionPickerGroup(input: {
  accountId: string;
  projectId: string;
  userId: string;
  access: ProjectModelAccess;
  modelOverrides: Record<string, boolean>;
}) {
  const connected = (await countUsableClaudeAccounts(input.accountId, input.projectId, input.userId).catch(() => 0)) > 0;
  return {
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    name: CLAUDE_AGENT_PROVIDER_NAME,
    connected,
    models: CLAUDE_AGENT_MODELS.map((model) => {
      const id = `${CLAUDE_AGENT_PROVIDER_ID}/${model.id}`;
      return {
        id,
        name: model.name,
        description: model.description,
        limit: { context: model.context, output: model.output },
        efforts: [...CLAUDE_AGENT_EFFORTS],
        requires: 'claude_subscription' as const,
        connected,
        enabled: modelAccessAllows(input.access, id) && (input.modelOverrides[id] ?? true),
      };
    }),
  };
}
