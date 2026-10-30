/**
 * `/kortix models`, `/kortix model <id>` and the model picker's controls, in
 * one place — the Slack side of channels/model-access.ts.
 *
 * The list and every check run as the person who typed (their linked Kortix
 * user). Their own API keys and ChatGPT subscription count only in a DM with
 * the bot, whose sessions are private to them; a channel is shared, so only
 * keys shared with the whole project count there. A choice that runs on
 * provider keys starts each new thread with every key the conversation may
 * use, so they rotate. A Slack thread is one session: a channel's choice
 * starts every NEW thread, and a thread keeps the model it started with.
 */
import { config } from '../../config';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import {
  type ChannelModelOption,
  type ChannelModelScope,
  agentGrantEnvFor,
  channelKeySelection,
  channelModelScope,
  checkChannelModel,
  describeKeys,
  listChannelModels,
} from '../model-access';
import { chatUser, resolveChatActor } from '../core/identity';
import { authorizeChannelChange } from '../core/settings';
import { settingsRefusalText, slackSettingsChannel, slackUserOf } from './settings-text';
import { channelModelContext } from './model-gate';
import { currentChannelSelection, setChannelModel } from './selection';
import type { SlashResponse } from './types';
import { escapeMrkdwn } from './util';

export interface SlackModelCtx {
  teamId: string;
  channelId: string;
  /** The Slack user who typed or clicked; '' when unknown. */
  slackUserId: string;
  /** The slash command's name (`/kortix`), for the copy. */
  command: string;
}

/** Up to this many models are one button each; more become one searchable select. */
const MAX_MODEL_BUTTONS = 10;
/** Slack's limit on the options of one select. */
const MAX_SELECT_OPTIONS = 100;
/** Slack's limit on an option's text, and on its value. */
const MAX_OPTION_TEXT = 75;
const MAX_OPTION_VALUE = 150;

const PERSONAL_SCOPE_NOTE = 'Includes your own API keys and ChatGPT subscriptions. When a provider has several keys, they rotate.';
const SHARED_SCOPE_NOTE =
  'Only keys shared with the whole project work here: this channel is shared. Your own keys and ChatGPT subscription work in a DM with me.';

/** A DM with the bot. Slack DM channel ids start with `D`; group DMs and channels do not. */
export function slackChannelIsDm(channelId: string): boolean {
  return channelId.startsWith('D');
}

/**
 * Who this conversation's model decisions are made for; null when no project
 * is connected. With `SLACK_REQUIRE_USER_IDENTITY` off, sessions run as the
 * account owner with no one on whose behalf they act, so no one's personal
 * keys count, linked or not.
 */
export async function slackModelScope(ctx: SlackModelCtx): Promise<ChannelModelScope | null> {
  const gate = await channelModelContext({ teamId: ctx.teamId, channelId: ctx.channelId });
  if (!gate) return null;
  const sender = config.SLACK_REQUIRE_USER_IDENTITY ? ctx.slackUserId : '';
  const actor = sender
    ? await resolveChatActor(chatUser('slack', ctx.teamId, sender), gate).catch(() => null)
    : null;
  const pooledEnabled = await projectFeatureFlagEnabled(gate.projectId, 'pooled_provider_secrets').catch(() => false);
  return channelModelScope({
    ...gate,
    pooledEnabled,
    linkedUserId: actor && 'userId' in actor ? actor.userId : null,
    oneToOne: slackChannelIsDm(ctx.channelId),
  });
}

function viaHint(model: ChannelModelOption): string {
  if (model.via === 'chatgpt') return 'ChatGPT subscription';
  if (model.via === 'key') return `${model.providerLabel} key`;
  return 'Kortix';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickValue(channelId: string, model: string): string {
  return JSON.stringify({ c: channelId, m: model });
}

const VIA_GROUPS: Array<{ via: ChannelModelOption['via']; label: string }> = [
  { via: 'chatgpt', label: 'ChatGPT subscriptions' },
  { via: 'key', label: 'API keys' },
  { via: 'kortix', label: 'Kortix models' },
];

/** The `/kortix models` picker. */
export async function buildSlackModelsResponse(ctx: SlackModelCtx): Promise<SlashResponse> {
  const scope = await slackModelScope(ctx);
  if (!scope) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project is connected to this channel yet.*\nRun \`${ctx.command}\` to connect one, then pick a model.` } }],
    };
  }
  const selection = await currentChannelSelection({ teamId: ctx.teamId, channelId: ctx.channelId });
  const current = selection?.opencodeModel ?? null;

  const { models, defaultModel } = await listChannelModels(scope);
  const currentWire = current ? toWireModel(current) : null;
  const keysNote = currentWire ? describeKeys(await channelKeySelection(scope, currentWire)) : null;
  const defaultLabel = defaultModel ? labelForModelRef(defaultModel) : null;
  const status = current
    ? `This channel uses *${escapeMrkdwn(labelForModelRef(current))}*.${keysNote ? ` ${escapeMrkdwn(keysNote)}` : ''}`
    : `This channel uses the *project default*${defaultLabel ? ` (${escapeMrkdwn(defaultLabel)})` : ''}.`;

  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: 'Models', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: status }] },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${current ? '' : '✓ '}*Use project default*${defaultLabel ? `  ·  _${escapeMrkdwn(defaultLabel)}_` : ''}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: current ? 'Reset' : '✓ Current', emoji: true },
        style: current ? 'primary' : undefined,
        action_id: 'set_model_default',
        value: pickValue(ctx.channelId, ''),
      },
    },
  ];

  if (models.length <= MAX_MODEL_BUTTONS) {
    for (const m of models) {
      const cur = currentWire === m.id;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${cur ? '✓ ' : ''}*${escapeMrkdwn(m.label)}*  ·  _${escapeMrkdwn(viaHint(m))}_\n\`${escapeMrkdwn(m.id)}\`` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: cur ? '✓ Current' : 'Use this', emoji: true },
          style: cur ? undefined : 'primary',
          action_id: `set_model_${m.id}`.slice(0, 250),
          value: pickValue(ctx.channelId, m.id),
        },
      });
    }
  } else {
    // Slack caps a message at 50 blocks, so a long list is one select — typing
    // in it filters. A model past its 100 options is still one
    // `/kortix model <id>` away.
    const listed = models.filter((m) => pickValue(ctx.channelId, m.id).length <= MAX_OPTION_VALUE).slice(0, MAX_SELECT_OPTIONS);
    const option = (m: ChannelModelOption) => ({
      text: { type: 'plain_text', text: clip(`${m.label} · ${viaHint(m)}`, MAX_OPTION_TEXT), emoji: true },
      value: pickValue(ctx.channelId, m.id),
    });
    const optionGroups = VIA_GROUPS.map((group) => ({
      label: { type: 'plain_text', text: group.label },
      options: listed.filter((m) => m.via === group.via).map(option),
    })).filter((group) => group.options.length > 0);
    const initial = listed.find((m) => m.id === currentWire);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${models.length} models* — type to search.` },
      accessory: {
        type: 'static_select',
        action_id: 'set_model_select',
        placeholder: { type: 'plain_text', text: 'Pick a model', emoji: true },
        option_groups: optionGroups,
        ...(initial ? { initial_option: option(initial) } : {}),
      },
    });
    if (listed.length < models.length) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Showing ${listed.length} of ${models.length}. Any other: \`${ctx.command} model provider/model-id\`.` }],
      });
    }
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: scope.personalUserId ? PERSONAL_SCOPE_NOTE : SHARED_SCOPE_NOTE },
      { type: 'mrkdwn', text: `Any model works: \`${ctx.command} model provider/model-id\`. New threads use the channel's model.` },
    ],
  });
  return { response_type: 'ephemeral', blocks };
}

/**
 * Set (or reset, with '' / 'default') this conversation's model. Returns the
 * mrkdwn line to show the person.
 */
export async function applySlackModelChoice(ctx: SlackModelCtx, choice: string): Promise<string> {
  const connect = `Connect a project first — run \`${ctx.command}\`.`;
  const channelCtx = { teamId: ctx.teamId, channelId: ctx.channelId };
  const id = choice.trim();
  const scope = await slackModelScope(ctx);
  if (!scope) return connect;
  const auth = await authorizeChannelChange(slackUserOf(ctx), slackSettingsChannel(ctx));
  if (!auth.ok) return settingsRefusalText(auth.reason, ctx.command, connect);
  if (!id || id.toLowerCase() === 'default') {
    return (await setChannelModel(channelCtx, null)) ? 'Model reset to the project default.' : connect;
  }
  if (/\s/.test(id)) {
    return `\`${escapeMrkdwn(id)}\` doesn't look like a model id. Use \`provider/model\` (e.g. \`anthropic/claude-sonnet-4.6\`) or a managed id (e.g. \`kortix/deepseek-v4.1-flash\` or \`deepseek-v4.1-flash\`).`;
  }

  const selection = await currentChannelSelection(channelCtx);
  const agentName = selection?.agentName ?? null;
  const agentGrantEnv = agentGrantEnvFor(scope.projectId, agentName);
  const verdict = await checkChannelModel(scope, id, { agentGrantEnv });
  const label = escapeMrkdwn(labelForModelRef(id));
  if (!verdict.ok) {
    if (verdict.reason === 'agent_grant') {
      const what = verdict.providerId === 'codex' ? 'ChatGPT connections' : `${verdict.providerId} keys`;
      return `The *${escapeMrkdwn(agentName || 'default')}* agent may not use ${what}. Add \`${verdict.envVar}\` to its \`secrets\` in kortix.yaml, or pick another model.`;
    }
    // Would it work with the person's own keys? Then say where it does. Only
    // for a linked person: an unlinked one runs as the account owner, whose
    // own keys are never theirs to be told about.
    if (!scope.personalUserId && scope.linkedUserId) {
      const personal = await checkChannelModel({ ...scope, personalUserId: scope.linkedUserId }, id, { agentGrantEnv });
      if (personal.ok) {
        return `*${label}* runs on your own API key or ChatGPT subscription, which this shared channel cannot use. Pick it in a DM with me, or pick a model the project shares.`;
      }
    }
    return `\`${escapeMrkdwn(id)}\` isn't available for this workspace. Pick one from \`${ctx.command} models\`, or connect that provider in Kortix first.`;
  }
  if (!(await setChannelModel(channelCtx, verdict.model))) return connect;
  const keysNote = describeKeys(verdict.keys);
  return `Model for this channel set to *${escapeMrkdwn(labelForModelRef(verdict.model))}* (\`${escapeMrkdwn(verdict.model)}\`).${keysNote ? ` ${escapeMrkdwn(keysNote)}` : ''} New threads use it.`;
}
