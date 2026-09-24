/**
 * `/models`, `/model <id>` and the model card's buttons, in one place.
 *
 * The list and every check run as the person who typed (their linked Kortix
 * user) with this conversation's personal scope — see channels/model-access.
 * A choice that needs provider keys selects every key the conversation may
 * use, so they rotate, and the conversation's live session is pointed at them
 * at once: a Teams chat keeps one session, so "new sessions will use it" meant
 * the choice did nothing until `/new`.
 */
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { validateNativeOpencodeModelRef } from '../../projects/lib/session-model-change';
import { config } from '../../config';
import {
  type ChannelModelScope,
  agentGrantEnvFor,
  applyChannelSessionKeys,
  channelKeySelection,
  channelModelScope,
  checkChannelModel,
  describeKeys,
  listChannelModels,
  sessionModelScope,
} from '../model-access';
import { channelModelContext } from '../slack/model-gate';
import { currentChannelSelection, setChannelModel } from '../slack/selection';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { type TeamsConversationSession, conversationSession, teamsChannelCtx } from './binding';
import { buildModelPickerCard, buildNoticeCard } from './cards';
import { normalizeConversationPolicy } from './participants';
import { resolveTeamsActor, teamsUserId } from './identity';
import type { TeamsActivity } from './types';
import { isPersonalChat } from './util';

const PERSONAL_SCOPE_NOTE = 'Includes your own API keys and ChatGPT subscriptions. When a provider has several keys, they rotate.';
const SHARED_SCOPE_NOTE =
  'Here, only keys shared with the whole project work: this chat is shared. Your own keys and ChatGPT subscription work in a personal chat with me.';

/**
 * Who this conversation's model decisions are made for; null when no project
 * is connected. With `TEAMS_REQUIRE_USER_IDENTITY` off, sessions run as the
 * account owner with no one on whose behalf they act, so no one's personal
 * keys count, linked or not.
 */
export async function teamsModelScope(activity: TeamsActivity, tenantId: string, conversationId: string): Promise<ChannelModelScope | null> {
  const ctx = teamsChannelCtx(tenantId, conversationId);
  const gate = await channelModelContext(ctx);
  if (!gate) return null;
  const sender = config.TEAMS_REQUIRE_USER_IDENTITY ? teamsUserId(activity) : null;
  const actor = sender ? await resolveTeamsActor(tenantId, sender, gate.accountId, gate.projectId).catch(() => null) : null;
  const pooledEnabled = await projectFeatureFlagEnabled(gate.projectId, 'pooled_provider_secrets').catch(() => false);
  return channelModelScope({
    ...gate,
    pooledEnabled,
    linkedUserId: actor && 'userId' in actor ? actor.userId : null,
    oneToOne: isPersonalChat(activity),
  });
}

export async function buildTeamsModelsCard(activity: TeamsActivity, tenantId: string, conversationId: string) {
  const ctx = teamsChannelCtx(tenantId, conversationId);
  const scope = await teamsModelScope(activity, tenantId, conversationId);
  if (!scope) return buildNoticeCard('Connect a project to this conversation first — try /projects.', '📁');
  const selection = await currentChannelSelection(ctx);
  const current = selection?.opencodeModel ?? null;
  if (!scope.llmGatewayEnabled) {
    return buildNoticeCard(
      current
        ? `This conversation uses \`${current}\`. This project runs native OpenCode models (LLM gateway off) — set any connected provider's model with \`/model provider/model\`, or \`/model default\` to reset.`
        : 'This conversation uses the project default (resolved by OpenCode in the sandbox). This project runs native OpenCode models (LLM gateway off) — set any connected provider\'s model with `/model provider/model`, e.g. `/model anthropic/claude-sonnet-4-6`.',
      '🧠',
    );
  }
  const { models, defaultModel } = await listChannelModels(scope);
  const currentWire = current ? toWireModel(current) : null;
  const keys = currentWire ? await channelKeySelection(scope, currentWire) : null;
  return buildModelPickerCard({
    models,
    current: currentWire,
    currentLabel: current ? labelForModelRef(current) : null,
    defaultLabel: defaultModel ? labelForModelRef(defaultModel) : null,
    keysNote: describeKeys(keys),
    scopeNote: scope.personalUserId ? PERSONAL_SCOPE_NOTE : SHARED_SCOPE_NOTE,
  });
}

/** Set (or reset, with '' / 'default') this conversation's model. Returns the card to show. */
export async function applyTeamsModelChoice(
  activity: TeamsActivity,
  tenantId: string,
  conversationId: string,
  choice: string,
) {
  const ctx = teamsChannelCtx(tenantId, conversationId);
  const id = choice.trim();
  const scope = await teamsModelScope(activity, tenantId, conversationId);
  if (!scope) return buildNoticeCard('Connect a project to this conversation first.');
  if (!id || id.toLowerCase() === 'default') {
    await setChannelModel(ctx, null);
    return buildNoticeCard('Model reset to the project default.', '✅');
  }
  // Native mode (gateway off): no gateway catalog — accept a native
  // `provider/model` ref verbatim.
  if (!scope.llmGatewayEnabled) {
    if (validateNativeOpencodeModelRef(id)) {
      return buildNoticeCard(`\`${id}\` isn't usable here — this project runs native OpenCode models (LLM gateway off). Use \`provider/model\`, e.g. \`anthropic/claude-sonnet-4-6\`.`);
    }
    await setChannelModel(ctx, id);
    return buildNoticeCard(`Model set to \`${id}\`. New sessions will use it.`);
  }

  const selection = await currentChannelSelection(ctx);
  // The live session decides what the next message can use: its agent's
  // secret grant, and whether it reaches the person's own keys. A personal
  // chat's session created before these became private is shared, so it
  // cannot, whatever the chat is.
  const live = await conversationSession(tenantId, conversationId).catch(() => null);
  if (live?.sessionId) {
    // The choice reaches the live session: every message in it runs on the
    // new model and keys. Choosing needs the same standing as sending one.
    if (config.TEAMS_REQUIRE_USER_IDENTITY && !scope.linkedUserId) {
      return buildNoticeCard('Link your Kortix account first — send /login — then pick a model.');
    }
    // A session started under an owner-only or approval policy is its owner's.
    const policy = normalizeConversationPolicy(live.conversationPolicy ?? selection?.conversationPolicy);
    if (policy !== 'project_open' && live.createdBy && scope.linkedUserId && live.createdBy !== scope.linkedUserId) {
      return buildNoticeCard("Only the person who started this chat's session can change its model.");
    }
  }
  const agentName = live?.agentName ?? selection?.agentName ?? null;
  const agentGrantEnv = agentGrantEnvFor(scope.projectId, agentName);
  const liveScope = live?.sessionId
    ? await sessionModelScope(scope, { sessionId: live.sessionId, ownerUserId: live.createdBy })
    : scope;
  const liveShared = Boolean(scope.personalUserId && !liveScope.personalUserId);
  const checkScope = { ...scope, personalUserId: liveScope.personalUserId };
  const verdict = await checkChannelModel(checkScope, id, { agentGrantEnv });
  const label = labelForModelRef(id);
  if (!verdict.ok) {
    if (verdict.reason === 'agent_grant') {
      const agent = agentName || 'default';
      return buildNoticeCard(
        `The ${agent} agent may not use ${verdict.providerId === 'codex' ? 'ChatGPT connections' : `${verdict.providerId} keys`}. Add \`${verdict.envVar}\` to its \`secrets\` in kortix.yaml, or pick another model.`,
      );
    }
    // Would it work with the person's own keys? Then say what stands in the way.
    // Only for a linked person: an unlinked one runs as the account owner,
    // whose own keys are never theirs to be told about.
    if (!checkScope.personalUserId && scope.linkedUserId) {
      const personal = await checkChannelModel({ ...scope, personalUserId: scope.linkedUserId }, id, { agentGrantEnv });
      if (personal.ok && liveShared) {
        // Stored anyway: the private session `/new` starts will use it.
        await setChannelModel(ctx, personal.model);
        return buildNoticeCard(
          `Model set to ${label}. It runs on your own API key or ChatGPT subscription, and this chat's current session is shared with your project, so it cannot use it. Send /new to start a session that is private to you — it will.`,
          '✅',
        );
      }
      if (personal.ok) {
        return buildNoticeCard(`${label} runs on your own API key or ChatGPT subscription, which this shared chat cannot use. Pick it in a personal chat with me, or pick a model the project shares.`);
      }
    }
    return buildNoticeCard(`${label} isn't available in this conversation. Pick one with /models, or connect that provider in Kortix.`);
  }

  await setChannelModel(ctx, verdict.model);
  if (live?.sessionId) await applyChannelSessionKeys({ sessionId: live.sessionId, keys: verdict.keys, replace: true });
  const keysNote = describeKeys(verdict.keys);
  return buildNoticeCard(`Model set to ${label}.${keysNote ? ` ${keysNote}` : ''} Your next message uses it.`, '✅');
}

/**
 * The model the next message runs on: this conversation's `/model` choice —
 * it reaches the live session too — else the model the live session started
 * with, else the project default. "project default" beside a session pinned
 * to another model was how a chat stuck on a model it could not run looked
 * fine here. Off the gateway a choice waits for `/new`, so both are named.
 */
export function statusModel(
  choice: string | null,
  session: Pick<TeamsConversationSession, 'opencodeModel'> | null,
  gatewayOn: boolean,
): string {
  const pinned = session?.opencodeModel ?? null;
  if (choice && (gatewayOn || !pinned || pinned === choice)) return labelForModelRef(choice);
  if (choice && pinned) return `${labelForModelRef(pinned)} (this session; ${labelForModelRef(choice)} from /new)`;
  if (pinned) return `${labelForModelRef(pinned)} (this session)`;
  return 'project default';
}
