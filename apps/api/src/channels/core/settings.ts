import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { validateNativeOpencodeModelRef } from '../../projects/lib/session-model-change';
import { channelModelContext } from '../slack/model-gate';
import {
  type ChannelCtx,
  currentChannelSelection,
  setChannelAgent,
  setChannelConversationPolicy,
  setChannelModel,
} from '../slack/selection';
import { type ChatUser, resolveProjectChatActor } from './identity';

/**
 * Channel settings: the project a chat channel runs, and the agent, model and
 * session policy that new sessions there start with.
 *
 * The settings belong to the project, so changing one needs the capability
 * that edits the binding on the web (`PATCH /projects/:id/channels/bindings`):
 * `project.connector.write`, held by project managers and by account owners
 * and admins, through a linked chat identity. Every Slack command, Slack
 * button, Teams command and Teams card that writes a setting calls this
 * module, so that check exists once.
 *
 * Re-pointing a bound channel to another project needs the capability on
 * both projects. The first binding of an unbound channel stays open, as the
 * project picker always was: the channel's next message still runs only for
 * a sender who may work in the chosen project.
 */

export type SettingsRefusal = 'unlinked' | 'forbidden' | 'no_binding';

export type SettingsChange<Ok extends object = object, Reason extends string = never> =
  | ({ ok: true } & Ok)
  | { ok: false; reason: SettingsRefusal | Reason };

/** May `user` change the settings of a channel that runs `projectId`? */
export async function authorizeChannelSettings(
  user: ChatUser,
  projectId: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: 'unlinked' | 'forbidden' }> {
  const actor = await resolveProjectChatActor(user, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  if ('userId' in actor) return { ok: true, userId: actor.userId };
  return { ok: false, reason: actor.reason === 'unlinked' ? 'unlinked' : 'forbidden' };
}

async function authorizeBoundChannel(user: ChatUser, channel: ChannelCtx): Promise<SettingsChange> {
  const selection = await currentChannelSelection(channel);
  if (!selection) return { ok: false, reason: 'no_binding' };
  return authorizeChannelSettings(user, selection.projectId);
}

/**
 * Pin the channel model. `null`, '' and `default` reset it to the project
 * default. A gateway project stores a servable id as its OpenCode ref; a
 * native project (LLM gateway off) stores a `provider/model` ref verbatim.
 */
export async function changeChannelModel(
  user: ChatUser,
  channel: ChannelCtx,
  requested: string | null,
): Promise<SettingsChange<{ model: string | null; native: boolean }, 'invalid_id' | 'not_native' | 'not_servable'>> {
  const auth = await authorizeBoundChannel(user, channel);
  if (!auth.ok) return auth;
  const id = requested?.trim() ?? '';
  if (!id || id.toLowerCase() === 'default') {
    if (!(await setChannelModel(channel, null))) return { ok: false, reason: 'no_binding' };
    return { ok: true, model: null, native: false };
  }
  if (/\s/.test(id)) return { ok: false, reason: 'invalid_id' };
  const gate = await channelModelContext(channel);
  if (!gate) return { ok: false, reason: 'no_binding' };
  let stored = id;
  if (gate.llmGatewayEnabled) {
    // Never store a model that would 404 at request time.
    const servable = await isModelServableForAccount({
      userId: gate.ownerUserId,
      accountId: gate.accountId,
      projectId: gate.projectId,
      freeModelsOnly: gate.freeManagedOnly,
      model: id,
    });
    if (!servable) return { ok: false, reason: 'not_servable' };
    stored = toOpencodeModelRef(id);
  } else if (validateNativeOpencodeModelRef(id)) {
    return { ok: false, reason: 'not_native' };
  }
  if (!(await setChannelModel(channel, stored))) return { ok: false, reason: 'no_binding' };
  return { ok: true, model: stored, native: !gate.llmGatewayEnabled };
}

/** Pin the channel agent. `null`, '' and `default` reset it to the project default. */
export async function changeChannelAgent(
  user: ChatUser,
  channel: ChannelCtx,
  requested: string | null,
): Promise<SettingsChange<{ agent: string | null }, 'unknown_agent'>> {
  const auth = await authorizeBoundChannel(user, channel);
  if (!auth.ok) return auth;
  const name = requested?.trim() ?? '';
  const agent = name && name.toLowerCase() !== 'default' ? name : null;
  const result = await setChannelAgent(channel, agent);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, agent };
}

/** Set who may join sessions started in the channel. `policy` is already normalized. */
export async function changeChannelPolicy(
  user: ChatUser,
  channel: ChannelCtx,
  policy: string,
): Promise<SettingsChange> {
  const auth = await authorizeBoundChannel(user, channel);
  if (!auth.ok) return auth;
  if (!(await setChannelConversationPolicy(channel, policy))) return { ok: false, reason: 'no_binding' };
  return { ok: true };
}

/** Point the channel at `projectId`, which must be installed in the channel's workspace. */
export async function switchChannelProject(
  user: ChatUser,
  channel: ChannelCtx,
  projectId: string,
): Promise<SettingsChange<object, 'not_installed'>> {
  const platform = channel.platform ?? 'slack';
  const current = (await currentChannelSelection(channel))?.projectId ?? null;
  if (current && current !== projectId) {
    for (const id of [current, projectId]) {
      const auth = await authorizeChannelSettings(user, id);
      if (!auth.ok) return auth;
    }
  }
  const [install] = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, platform),
        eq(chatInstalls.workspaceId, channel.teamId),
        eq(chatInstalls.projectId, projectId),
      ),
    )
    .limit(1);
  if (!install) return { ok: false, reason: 'not_installed' };
  await db
    .insert(chatChannelBindings)
    .values({ platform, workspaceId: channel.teamId, channelId: channel.channelId, projectId, pickerTs: null })
    .onConflictDoUpdate({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
      set: { projectId, pickerTs: null },
    });
  return { ok: true };
}

/** Remove the channel's binding. An unbound channel is already done. */
export async function unbindChannel(user: ChatUser, channel: ChannelCtx): Promise<SettingsChange> {
  const current = await currentChannelSelection(channel);
  if (current) {
    const auth = await authorizeChannelSettings(user, current.projectId);
    if (!auth.ok) return auth;
  }
  await db
    .delete(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, channel.platform ?? 'slack'),
        eq(chatChannelBindings.workspaceId, channel.teamId),
        eq(chatChannelBindings.channelId, channel.channelId),
      ),
    );
  return { ok: true };
}
