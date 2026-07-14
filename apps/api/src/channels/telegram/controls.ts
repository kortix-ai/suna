/**
 * `/agent` and `/model` pickers — inline-keyboard control of the chat's
 * `chatChannelBindings` overrides (the same storage Slack's `/kortix agent` /
 * `models` write). Pure builders/encoders are unit-testable; the post/handle
 * functions do the DB + transport.
 *
 * callback_data carries the chosen VALUE directly (`kxa:<agentName>` /
 * `kxm:<modelId>`, empty = reset to project default). Agent names and opencode
 * model refs comfortably fit Telegram's 64-byte callback_data cap; any option
 * that wouldn't is dropped from the keyboard (logged) rather than risking a
 * BUTTON_DATA_INVALID on the whole message.
 */

import { labelForModelRef, listPickerModels } from '../../llm-gateway/models/picker';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { loadTelegramTokenForProject } from '../install-store';
import { channelModelContext } from '../slack/model-gate';
import {
  type ChannelCtx,
  currentChannelSelection,
  loadProjectAgentGovernance,
  setChannelAgent,
  setChannelModel,
} from '../slack/selection';
import { type TelegramInlineButton, telegramSendMessage } from '../telegram-api';

const AGENT_PREFIX = 'kxa';
const MODEL_PREFIX = 'kxm';
const MAX_CALLBACK_BYTES = 64;
/** Keep pickers phone-sized; the catalogs are curated but guard anyway. */
const MAX_PICKER_OPTIONS = 12;

export type ControlPickKind = 'agent' | 'model';

export function encodePickCallback(kind: ControlPickKind, value: string): string {
  return `${kind === 'agent' ? AGENT_PREFIX : MODEL_PREFIX}:${value}`;
}

export function decodePickCallback(
  data: string | undefined,
): { kind: ControlPickKind; value: string } | null {
  if (!data) return null;
  if (data.startsWith(`${AGENT_PREFIX}:`))
    return { kind: 'agent', value: data.slice(AGENT_PREFIX.length + 1) };
  if (data.startsWith(`${MODEL_PREFIX}:`))
    return { kind: 'model', value: data.slice(MODEL_PREFIX.length + 1) };
  return null;
}

export function isControlCallback(data: string | undefined): boolean {
  return decodePickCallback(data) !== null;
}

interface PickOption {
  value: string;
  label: string;
  /** True when this option is the chat's current selection (gets a ✓). */
  current?: boolean;
}

/**
 * One option per row, ✓ on the current one, a leading "Project default" reset
 * row. Options whose encoded callback_data exceeds 64 bytes are dropped
 * (returned in `dropped` so the caller can log — real ids never hit this).
 */
export function buildPickerKeyboard(
  kind: ControlPickKind,
  options: PickOption[],
  currentIsDefault: boolean,
): { keyboard: TelegramInlineButton[][]; dropped: string[] } {
  const keyboard: TelegramInlineButton[][] = [
    [
      {
        text: `${currentIsDefault ? '✓ ' : ''}Project default`,
        callbackData: encodePickCallback(kind, ''),
      },
    ],
  ];
  const dropped: string[] = [];
  for (const o of options.slice(0, MAX_PICKER_OPTIONS)) {
    const cb = encodePickCallback(kind, o.value);
    if (Buffer.byteLength(cb) > MAX_CALLBACK_BYTES) {
      dropped.push(o.value);
      continue;
    }
    keyboard.push([{ text: `${o.current ? '✓ ' : ''}${o.label}`, callbackData: cb }]);
  }
  return { keyboard, dropped };
}

function ctxFor(botId: string, chatId: string): ChannelCtx {
  return { platform: 'telegram', teamId: botId, channelId: chatId };
}

/** Post the agent picker (or a "no agents declared" note). */
export async function postTelegramAgentPicker(
  projectId: string,
  botId: string,
  chatId: string,
  replyToMessageId: number,
): Promise<void> {
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return;
  const ctx = ctxFor(botId, chatId);
  const [governance, selection] = await Promise.all([
    loadProjectAgentGovernance(projectId),
    currentChannelSelection(ctx),
  ]);
  const current = selection?.agentName ?? null;
  if (governance.agents.length === 0) {
    await telegramSendMessage(
      token,
      chatId,
      'This project has no named agents to choose from — it runs a single default agent.',
      { replyToMessageId },
    );
    return;
  }
  const { keyboard } = buildPickerKeyboard(
    'agent',
    governance.agents.map((a) => ({ value: a.name, label: a.name, current: a.name === current })),
    current == null,
  );
  await telegramSendMessage(token, chatId, '<b>Which agent should answer here?</b>', {
    parseMode: 'HTML',
    replyToMessageId,
    keyboard,
  });
}

/** Post the model picker (real served catalog, project default first). */
export async function postTelegramModelPicker(
  projectId: string,
  botId: string,
  chatId: string,
  replyToMessageId: number,
): Promise<void> {
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return;
  const ctx = ctxFor(botId, chatId);
  const gate = await channelModelContext(ctx);
  if (!gate) {
    await telegramSendMessage(token, chatId, 'No project is connected to this chat yet.', {
      replyToMessageId,
    });
    return;
  }
  const selection = await currentChannelSelection(ctx);
  const current = selection?.opencodeModel ?? null;
  const { models } = await listPickerModels({
    projectId: gate.projectId,
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    freeManagedOnly: gate.freeManagedOnly,
    agentName: selection?.agentName ?? null,
  });
  if (models.length === 0) {
    await telegramSendMessage(
      token,
      chatId,
      'No models are available to pick — this chat uses the project default.',
      { replyToMessageId },
    );
    return;
  }
  const isCurrent = (id: string) => !!current && toWireModel(current) === toWireModel(id);
  const { keyboard, dropped } = buildPickerKeyboard(
    'model',
    models.map((m) => ({ value: m.id, label: m.label, current: isCurrent(m.id) })),
    current == null,
  );
  if (dropped.length) {
    console.warn(
      '[telegram-controls] models dropped from picker (callback_data too long)',
      dropped,
    );
  }
  await telegramSendMessage(token, chatId, '<b>Which model should this chat run on?</b>', {
    parseMode: 'HTML',
    replyToMessageId,
    keyboard,
  });
}

/**
 * Apply a picker tap. Returns a short toast for answerCallbackQuery + the edited
 * confirmation text; null if the callback isn't a control pick.
 */
export async function applyControlPick(
  botId: string,
  chatId: string,
  data: string | undefined,
): Promise<{ toast: string } | null> {
  const decoded = decodePickCallback(data);
  if (!decoded) return null;
  const ctx = ctxFor(botId, chatId);
  const value = decoded.value || null;

  if (decoded.kind === 'agent') {
    const res = await setChannelAgent(ctx, value);
    if (!res.ok) {
      return {
        toast:
          res.reason === 'unknown_agent'
            ? 'That agent is no longer available.'
            : "Couldn't update the agent.",
      };
    }
    return { toast: value ? `Agent set to ${value}` : 'Agent reset to project default' };
  }

  const ok = await setChannelModel(ctx, value);
  if (!ok) return { toast: "Couldn't update the model." };
  return {
    toast: value ? `Model set to ${labelForModelRef(value)}` : 'Model reset to project default',
  };
}
