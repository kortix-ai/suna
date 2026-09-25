import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { PROJECT_ACTIONS } from '../../iam/actions';
import {
  type ChannelCtx,
  currentChannelSelection,
  setChannelAgent,
  setChannelConversationPolicy,
} from '../slack/selection';
import { type ChatUser, resolveProjectChatActor } from './identity';

/**
 * Channel settings: the project a chat channel runs, and the agent, model and
 * session policy that new sessions there start with.
 *
 * A shared channel's settings belong to the project, so changing one needs
 * the capability that edits the binding on the web (`PATCH
 * /projects/:id/channels/bindings`): `project.connector.write`, held by
 * project managers and by account owners and admins, through a linked chat
 * identity. A one-to-one conversation with the bot (a Slack DM, a Teams
 * personal chat) affects only that person, so there the bar is the one for
 * sending a message: `project.write`. Every Slack command, Slack button, Teams
 * command and Teams card that writes a setting goes through
 * `authorizeChannelSettings`, so that check exists once. The model setters
 * (slack/model-choice.ts, teams/model-choice.ts) call `authorizeChannelChange`.
 *
 * Re-pointing a bound channel to another project needs the capability on
 * both projects. The first binding of an unbound channel stays open, as the
 * project picker always was: the channel's next message still runs only for
 * a sender who may work in the chosen project.
 */

/** A channel as settings see it: `oneToOne` for a DM or personal chat with the bot. */
export type SettingsChannel = ChannelCtx & { oneToOne?: boolean };

export type SettingsRefusal = 'unlinked' | 'forbidden' | 'no_binding';

export type SettingsChange<Ok extends object = object, Reason extends string = never> =
  | ({ ok: true } & Ok)
  | { ok: false; reason: SettingsRefusal | Reason };

/** May `user` change the settings of a channel that runs `projectId`? */
export async function authorizeChannelSettings(
  user: ChatUser,
  projectId: string,
  opts: { oneToOne?: boolean } = {},
): Promise<{ ok: true; userId: string } | { ok: false; reason: 'unlinked' | 'forbidden' }> {
  const action = opts.oneToOne ? PROJECT_ACTIONS.PROJECT_WRITE : PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE;
  const actor = await resolveProjectChatActor(user, projectId, action);
  if ('userId' in actor) return { ok: true, userId: actor.userId };
  return { ok: false, reason: actor.reason === 'unlinked' ? 'unlinked' : 'forbidden' };
}

/** May `user` change a setting of `channel`, given the project it is bound to? */
export async function authorizeChannelChange(user: ChatUser, channel: SettingsChannel): Promise<SettingsChange> {
  const selection = await currentChannelSelection(channel);
  if (!selection) return { ok: false, reason: 'no_binding' };
  return authorizeChannelSettings(user, selection.projectId, channel);
}

/** Pin the channel agent. `null`, '' and `default` reset it to the project default. */
export async function changeChannelAgent(
  user: ChatUser,
  channel: SettingsChannel,
  requested: string | null,
): Promise<SettingsChange<{ agent: string | null }, 'unknown_agent'>> {
  const auth = await authorizeChannelChange(user, channel);
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
  channel: SettingsChannel,
  policy: string,
): Promise<SettingsChange> {
  const auth = await authorizeChannelChange(user, channel);
  if (!auth.ok) return auth;
  if (!(await setChannelConversationPolicy(channel, policy))) return { ok: false, reason: 'no_binding' };
  return { ok: true };
}

/** Point the channel at `projectId`, which must be installed in the channel's workspace. */
export async function switchChannelProject(
  user: ChatUser,
  channel: SettingsChannel,
  projectId: string,
): Promise<SettingsChange<object, 'not_installed'>> {
  const platform = channel.platform ?? 'slack';
  const current = (await currentChannelSelection(channel))?.projectId ?? null;
  if (current && current !== projectId) {
    for (const id of [current, projectId]) {
      const auth = await authorizeChannelSettings(user, id, channel);
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
export async function unbindChannel(user: ChatUser, channel: SettingsChannel): Promise<SettingsChange> {
  const current = await currentChannelSelection(channel);
  if (current) {
    const auth = await authorizeChannelSettings(user, current.projectId, channel);
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
