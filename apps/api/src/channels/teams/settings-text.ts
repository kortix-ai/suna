import { config } from '../../config';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import type { SettingsRefusal, changeChannelAgent, changeChannelModel } from '../core/settings';

// The Teams wording for channel-setting outcomes (core/settings.ts decides
// them), shared by the commands and the card buttons.

/**
 * The reply for a refused settings change, shared by the commands and the
 * card buttons. `noBinding` is the surface's own "connect a project" text.
 */
export function teamsSettingsRefusal(reason: SettingsRefusal, noBinding: string): string {
  switch (reason) {
    case 'unlinked':
      return config.TEAMS_REQUIRE_USER_IDENTITY
        ? 'Connect your Kortix account first — run `/login`. Settings change only for a linked project manager.'
        : "Change this conversation's settings in Kortix: Teams account linking is off on this server.";
    case 'forbidden':
      return "Only a project manager, or an account owner or admin, can change this conversation's settings.";
    case 'no_binding':
      return noBinding;
  }
}

/** The reply for a model change, shared by `/model` and the model picker card. */
export function teamsModelChangeText(result: Awaited<ReturnType<typeof changeChannelModel>>, requested: string): string {
  if (result.ok) {
    if (!result.model) return 'Model reset to the project default.';
    if (result.native) return `Model set to \`${result.model}\`. New sessions will use it.`;
    return `Model set to ${labelForModelRef(result.model)}. New sessions will use it.`;
  }
  switch (result.reason) {
    case 'invalid_id':
      return `\`${requested}\` doesn't look like a model id. Use \`provider/model\`, e.g. \`anthropic/claude-sonnet-4-6\`.`;
    case 'not_native':
      return `\`${requested}\` isn't usable here — this project runs native OpenCode models (LLM gateway off). Use \`provider/model\`, e.g. \`anthropic/claude-sonnet-4-6\`.`;
    case 'not_servable':
      return `\`${requested}\` isn't available here. Pick one with /models or connect that provider in Kortix.`;
    default:
      return teamsSettingsRefusal(result.reason, 'Connect a project to this conversation first.');
  }
}

/** The reply for an agent change, shared by `/agent` and the agent picker card. */
export function teamsAgentChangeText(result: Awaited<ReturnType<typeof changeChannelAgent>>, requested: string): string {
  if (result.ok) return result.agent ? `Agent set to ${result.agent}. New sessions will use it.` : 'Agent reset to the project default.';
  if (result.reason === 'unknown_agent') return `\`${requested}\` isn't a declared agent in this project. Try /agents.`;
  return teamsSettingsRefusal(result.reason, 'Connect a project to this conversation first.');
}
