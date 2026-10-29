/**
 * The chat commands (command-list.ts), written once for every platform.
 *
 *   help    → the commands and the project
 *   status  → the chat's project, agent, model and session, and how the session is doing
 *   stop    → abort the session's running turn, only when this chat (or no known source) prompted it
 *   new     → stop that turn, take the question buttons off, forget the chat's session
 *   model   → the models the whole project shares, or the chat's choice of one
 *   agent   → the agents no grant restricts, or the chat's choice of one
 *
 * The adapter parses the command, runs its sender gate, and renders the reply:
 * the core checks no person. A choice is stored per chat (`ctx.settings`); a
 * follow-up carries the model through the port's `turnModel` (conversation.ts).
 * A reply's buttons carry `kc:` tokens (command-press.ts); a press runs its
 * command as typed, in the pressed message's chat (`runCommandPress`).
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { abortRuntimeTurn, readRunningTurn, turnPromptSource } from '../../projects/surface';
import { agentGrantEnvFor, applyChannelSessionKeys, checkChannelModel, listChannelModels } from '../model-access';
import { chatAgents } from '../scoped-agents';
import { CHANNEL_COMMANDS, type ChannelCommandName, type ParsedCommand } from './command-list';
import { type CommandPress, choiceRef, parsePressData } from './command-press';
import { type ChannelTarget, forgetChatThread } from './conversation';
import { describeSession, projectWebUrl, sessionWebUrl } from './display';
import { chatSelection, chatSessionStart, chatTurnModel, sharedChatScope, statusModel } from './model-choice';
import { type QuestionPort, clearQuestionButtons } from './questions';
import { type SettingsChannel, ensureChatBinding, setChannelAgent, setChannelModel } from './settings';
import { type ChatThreadSession, claimThreadCreate, findChatThreadSession, releaseThreadCreate, threadCreateHeld } from './threads';

/** A button under a reply. */
export interface CommandAction {
  label: string;
  press: CommandPress;
}

/** Semantic, never markup: each platform renders it. `note` comes last; `actions` are buttons, in order. */
export type CommandReply = (
  | { kind: 'notice'; text: string; url?: string }
  | { kind: 'panel'; title: string; rows: ReadonlyArray<{ label: string; value: string }>; url?: string }
  | {
      kind: 'choices';
      title: string;
      /** One button each. */
      options: ReadonlyArray<{ label: string; current: boolean; press: CommandPress }>;
      /** 0-based page of `pages` (≥ 1). */
      page: number;
      pages: number;
      /** The presses that turn the page; absent on the first or last page. */
      back?: CommandPress;
      more?: CommandPress;
      usage: string;
    }
  | { kind: 'help'; intro: string; commands: ReadonlyArray<{ usage: string; description: string }>; footer: string }
) & { note?: string; actions?: ReadonlyArray<CommandAction> };

/** Teams' button cap (teams/cards.ts); a Discord string select holds 25 (from memory, unverified). */
const PAGE_SIZE = 8;
/** A button names a page in two digits (command-press.ts): a longer list is reachable by its typed command only. */
const MAX_PAGES = 100;
/** A used menu outlives a double tap, the job's retries and a failed edit; after this, a surviving button runs again. */
const PRESS_CLAIM_TTL_MS = 24 * 60 * 60_000;
/** A menu Kortix sent takes presses this long; after it, its buttons are out of date. */
const MENU_TTL_MS = 30 * 24 * 60 * 60_000;
export const OUT_OF_DATE = 'This menu is out of date. Send the command again for a new one.';

/**
 * Draws one reply: a new message for a typed command, the pressed message in place for a press.
 * Logs its errors; never throws.
 */
export type CommandRender = (reply: CommandReply) => Promise<void>;
/** Settles a press (Telegram: answerCallbackQuery). `text`: a short notice only the presser sees. Never throws. */
export type PressSettle = (text?: string) => Promise<void>;

/** One admitted command. The adapter already ran its sender gate: the core checks no person. */
export interface CommandContext {
  /** The conversation; `messageId` is the command's own message. */
  target: ChannelTarget;
  /** The project row the adapter loaded. */
  project: { projectId: string; accountId: string; name: string; metadata: unknown };
  /** The chat's settings row key. Telegram: the chat, so forum topics share it. */
  settings: SettingsChannel;
  /** Stored on the settings row; the Kortix Channels page names the row by it. */
  label: { name: string | null; type: string | null };
  /** `ChannelMessage.keys.createClaim` of this conversation. */
  createClaim: string;
  /** Present: the platform shows the agent's questions, and /new clears their buttons. */
  questions?: QuestionPort;
  /** The kind of a file the command's message carried ('photo'); the command does not send it. */
  droppedFile?: string;
}

/** Run one command and render exactly one reply. Catches every error: a job retry would reply twice. */
export async function runChannelCommand(ctx: CommandContext, command: ParsedCommand, render: CommandRender): Promise<void> {
  let reply: CommandReply;
  try {
    reply = await RUN[command.name](ctx, command.arg);
  } catch (error) {
    logger.warn('[channel] command failed', {
      platform: ctx.target.platform,
      projectId: ctx.project.projectId,
      command: command.name,
      error: error instanceof Error ? error.name : 'unknown',
    });
    reply = notice(`Kortix could not run /${command.name} just now. Send it again in a minute.`);
  }
  if (ctx.droppedFile) reply = { ...reply, note: `Your ${ctx.droppedFile} was not sent to the agent. Send it again without the command.` };
  await render(reply);
}

/** One row per menu message: `command-menu` while it takes presses, `command-press` once a terminal press used it. */
const messageKey = (kind: 'command-menu' | 'command-press', { platform, projectId, workspaceId, threadId, messageId }: ChannelTarget) =>
  `${platform}:${kind}:${projectId}:${workspaceId}:${threadId}|${messageId}`;

/**
 * Record a command reply with buttons that the adapter sent as `messageId` into `target`'s conversation.
 * Only such a message takes presses (`runCommandPress`): never a message the agent posted with `kc:`
 * data, nor a copy forwarded into another chat. An edit keeps the id, so a menu turned in place stays
 * valid. Never throws: a menu left unrecorded answers out of date.
 */
export async function rememberCommandMenu(target: ChannelTarget, messageId: string): Promise<void> {
  await claimThreadCreate(messageKey('command-menu', { ...target, messageId }), MENU_TTL_MS).catch((error) =>
    logger.warn('[channel] command menu not recorded', {
      platform: target.platform,
      projectId: target.projectId,
      error: error instanceof Error ? error.name : 'unknown',
    }),
  );
}

/**
 * A press on a command button, from a sender the adapter admitted, on the message `ctx.target.messageId`,
 * which must be a menu `rememberCommandMenu` recorded in this conversation.
 * Runs the command the token names in `ctx.target`'s conversation with the typed command's checks,
 * settles the press, then draws the reply over the pressed message. A terminal press (a pick, Stop,
 * New conversation) runs once per message, and after it no press on that message draws anything.
 * A token that no longer holds settles with OUT_OF_DATE and changes nothing. Catches every error:
 * a job retry would act twice.
 */
export async function runCommandPress(ctx: CommandContext, data: string, render: CommandRender, settle: PressSettle): Promise<void> {
  const press = parsePressData(data);
  if (!press) return settle(OUT_OF_DATE);
  const { platform, projectId } = ctx.target;
  const key = messageKey('command-press', ctx.target);
  let claim: Date | null = null;
  try {
    if (!(await threadCreateHeld(messageKey('command-menu', ctx.target)))) return await settle(OUT_OF_DATE);
    if (press.pick !== undefined || press.name === 'new' || press.name === 'stop') {
      claim = await claimThreadCreate(key, PRESS_CLAIM_TTL_MS);
      if (!claim) return await settle(OUT_OF_DATE);
    }
    const reply = await pressReply(ctx, press);
    if (reply === 'stale') {
      if (claim) await releaseThreadCreate(key, claim);
      return await settle(OUT_OF_DATE);
    }
    // A page turn on a menu that a pick, Stop or New conversation used, also while this page was read,
    // draws nothing over the result. ponytail: a terminal press that lands during the settle call still
    // loses its result to this page; a lock across the edit closes that.
    if (!claim && (await threadCreateHeld(key))) return await settle(OUT_OF_DATE);
    await settle();
    await render(reply);
  } catch (error) {
    logger.warn('[channel] command press failed', {
      platform,
      projectId,
      command: press.name,
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (claim) await releaseThreadCreate(key, claim).catch(() => undefined);
    await settle('Kortix could not do that just now. Try again in a minute.');
  }
}

/** The reply a press draws, or 'stale' when its option or session no longer holds. */
async function pressReply(ctx: CommandContext, press: CommandPress): Promise<CommandReply | 'stale'> {
  if (press.name === 'model' || press.name === 'agent') {
    if (press.pick === undefined) return PICKERS[press.name](ctx, press.page ?? 0);
    const value = await pickedValue(ctx, press.name, press.pick);
    return value === null ? 'stale' : RUN[press.name](ctx, value);
  }
  // A Stop bound to a session: after /new, it stops nothing.
  if (press.name === 'stop' && press.pick !== undefined && (await chatSession(ctx))?.sessionId !== press.pick) return 'stale';
  return RUN[press.name](ctx, '');
}

/** The model or agent a ref names in today's list; 'default' for 'd'; null: none (stale). */
async function pickedValue(ctx: CommandContext, name: 'model' | 'agent', ref: string): Promise<string | null> {
  if (ref === choiceRef('default')) return 'default';
  const values =
    name === 'model'
      ? (await listChannelModels(await sharedChatScope(ctx.project))).models.map((m) => m.id)
      : (await chatAgents(ctx.project.projectId)).map((a) => a.name);
  return values.find((v) => choiceRef(v) === ref) ?? null;
}

const notice = (text: string, url?: string): CommandReply => ({ kind: 'notice', text, ...(url ? { url } : {}) });

const NOT_CONNECTED = 'This bot is no longer connected to this Kortix project.';
/** A create holds the chat: the session it binds was planned before the choice changed. */
const CREATING = "Kortix is still creating this chat's session, which keeps its own";
/** A queued session has no sandbox yet: its turn cannot run, or be stopped. */
const STARTING = new Set(['queued', 'branching', 'provisioning']);

const sessionUrl = (ctx: CommandContext, sessionId: string) => sessionWebUrl(config.FRONTEND_URL, ctx.project.projectId, sessionId);

/** The chat's session. One deleted in the web (`metadata.deletedAt`) is none: the next message starts a new one (follow-up-delivery.ts). */
async function chatSession(ctx: CommandContext): Promise<ChatThreadSession | null> {
  const session = await findChatThreadSession(ctx.target, ctx.project.projectId);
  return typeof (session?.metadata as Record<string, unknown> | null | undefined)?.deletedAt === 'string' ? null : session;
}

function pinOf(session: ChatThreadSession | null): string | null {
  const pin = (session?.metadata as Record<string, unknown> | null | undefined)?.opencode_model;
  return typeof pin === 'string' && pin.trim() ? pin.trim() : null;
}

/** A model's name, and its id when the name differs. */
function modelName(id: string): string {
  const label = labelForModelRef(id);
  return label === id ? id : `${label} (${id})`;
}

/** At most `max` characters, with an ellipsis when cut, never half an emoji. */
function clipped(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** One page of a list; a page past the end is the last. */
function paged<T>(items: readonly T[], page: number): { shown: T[]; page: number; pages: number } {
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(items.length / PAGE_SIZE)));
  const at = Math.min(Math.max(page, 0), pages - 1);
  return { shown: items.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE), page: at, pages };
}

/**
 * One page of a model or agent list: the project default heads page 1, then the current option,
 * then the rest. `current`: the chosen value; null (or 'default') is the project default.
 */
function choices(
  name: 'model' | 'agent',
  title: string,
  items: ReadonlyArray<{ value: string; label: string }>,
  current: string | null,
  page: number,
  usage: string,
  defaultLabel = 'Project default',
): CommandReply {
  const chosen = current === 'default' ? null : current;
  const sorted = [...items.filter((i) => i.value === chosen), ...items.filter((i) => i.value !== chosen)];
  const at = paged(sorted, page);
  const option = (value: string, label: string, isCurrent: boolean) => ({ label, current: isCurrent, press: { name, pick: choiceRef(value) } });
  return {
    kind: 'choices',
    title,
    options: [
      ...(at.page === 0 ? [option('default', defaultLabel, chosen === null)] : []),
      ...at.shown.map((i) => option(i.value, i.label, i.value === chosen)),
    ],
    page: at.page,
    pages: at.pages,
    ...(at.page > 0 ? { back: { name, page: at.page - 1 } } : {}),
    ...(at.page < at.pages - 1 ? { more: { name, page: at.page + 1 } } : {}),
    usage,
  };
}

/** A list page per command; `RUN.model(ctx, '')` is page 0. */
const PICKERS: Record<'model' | 'agent', (ctx: CommandContext, page: number) => Promise<CommandReply>> = {
  async model(ctx, page) {
    const [session, selection, { models, defaultModel }] = await Promise.all([
      chatSession(ctx),
      chatSelection(ctx.settings, ctx.project.projectId),
      sharedChatScope(ctx.project).then(listChannelModels),
    ]);
    if (!models.length) return notice('No model is available to this chat. A project admin can share a provider key with the whole project in Kortix.');
    const current = selection?.opencodeModel ?? pinOf(session);
    const labels = new Map<string, number>();
    for (const m of models) labels.set(m.label, (labels.get(m.label) ?? 0) + 1);
    const defaultName = defaultModel && (models.find((m) => m.id === defaultModel)?.label ?? labelForModelRef(defaultModel));
    return choices(
      'model',
      'Models for this chat',
      models.map((m) => ({ value: m.id, label: labels.get(m.label)! > 1 ? `${m.label} · ${m.providerLabel}` : m.label })),
      current ? toWireModel(current) : null,
      page,
      // No `/model <id>` hint: a button shows a model's name, never the id to type.
      'Tap a model to use it in this chat. Only models and keys the whole project shares work here.',
      defaultName ? `Project default · ${defaultName}` : 'Project default',
    );
  },

  async agent(ctx, page) {
    const { projectId } = ctx.project;
    const [agents, session, selection] = await Promise.all([chatAgents(projectId), chatSession(ctx), chatSelection(ctx.settings, projectId)]);
    if (!agents.length) return notice('This project lists no agents this chat can use. New sessions run the project default agent.');
    return choices(
      'agent',
      'Agents for this chat',
      agents.map((a) => ({ value: a.name, label: clipped(a.description ? `${a.name} — ${a.description}` : a.name, 60) })),
      selection?.agentName ?? session?.agentName ?? null,
      page,
      'Tap an agent to use it for new sessions in this chat, or send /agent <name>.',
    );
  },
};

/**
 * The /status model row: the model the chat's next message runs on, decided as the follow-up
 * (`chatTurnModel`) or the create (`chatSessionStart`) decides it, and the model it replaces.
 */
async function modelRow(ctx: CommandContext, session: ChatThreadSession | null, choice: string | null): Promise<string> {
  const pin = pinOf(session);
  const wanted = choice ?? pin;
  if (!wanted) return 'project default';
  const named = statusModel(choice, pin);
  let runs: string | null;
  if (session) {
    runs = await chatTurnModel(ctx.settings, { sessionId: session.sessionId, projectId: ctx.project.projectId });
  } else {
    const start = await chatSessionStart(ctx.settings, ctx.project);
    if (start.unavailableModel) return `${named} — not available any more, so Kortix does not send this chat's messages. Send /model to pick another.`;
    runs = start.model ?? null;
  }
  if (!runs) return `${named} — not available here, and no other model replaces it. Send /model to pick another.`;
  if (toWireModel(runs) === toWireModel(wanted)) return named;
  return `${labelForModelRef(runs)} — ${choice ? "this chat's" : "this session's"} ${labelForModelRef(wanted)} is not available here`;
}

/** Shared by /stop and /new. */
type TurnStop = 'none' | 'starting' | 'elsewhere' | 'stopped' | 'unreachable';

/**
 * Stop the chat session's running turn, only when its prompt came from this platform or from no
 * known source: a turn the web, a trigger or Kortix itself (`system:*`) started is not the chat's.
 */
async function stopChatTurn(ctx: CommandContext, session: ChatThreadSession | null): Promise<TurnStop> {
  if (!session) return (await threadCreateHeld(ctx.createClaim)) ? 'starting' : 'none';
  const running = await readRunningTurn(session.sessionId);
  if (!running) return STARTING.has(session.status ?? '') ? 'starting' : 'none';
  const source = await turnPromptSource(session.sessionId, running.messageId);
  // Null is stoppable: a channel prompt carries no wire message id (its `continue_session` row has no
  // `wireMessageId` and no `forwarded_message_id`), so the chat's own run reads as unknown.
  if (source !== null && source !== ctx.target.platform) return 'elsewhere';
  return (await abortRuntimeTurn(session.sessionId, { requestedStop: true, stoppedBy: null })) ? 'stopped' : 'unreachable';
}

const RUN: Record<ChannelCommandName, (ctx: CommandContext, arg: string) => Promise<CommandReply>> = {
  async help(ctx) {
    return {
      kind: 'help',
      intro: `Kortix project ${ctx.project.name}. The agent answers in this chat.`,
      commands: CHANNEL_COMMANDS.map((c) => ({ usage: c.usage, description: c.description })),
      footer: 'Every other message goes to the agent, also one that starts with /.',
      actions: [
        { label: 'Status', press: { name: 'status' } },
        { label: 'New conversation', press: { name: 'new' } },
        { label: 'Model', press: { name: 'model' } },
        { label: 'Agent', press: { name: 'agent' } },
        { label: 'Stop', press: { name: 'stop' } },
      ],
    };
  },

  async status(ctx) {
    const session = await chatSession(ctx);
    const [held, selection, running] = await Promise.all([
      session ? false : threadCreateHeld(ctx.createClaim),
      chatSelection(ctx.settings, ctx.project.projectId),
      session ? readRunningTurn(session.sessionId) : null,
    ]);
    const model = await modelRow(ctx, session, selection?.opencodeModel ?? null);
    const sessionAgent = session?.agentName || 'default';
    const agent = !session
      ? selection?.agentName || 'project default'
      : selection?.agentName && selection.agentName !== sessionAgent
        ? `${sessionAgent} (new sessions: ${selection.agentName})`
        : sessionAgent;
    return {
      kind: 'panel',
      title: 'This chat in Kortix',
      rows: [
        { label: 'Project', value: ctx.project.name },
        { label: 'Agent', value: agent },
        { label: 'Model', value: model },
        {
          label: 'Session',
          value: session
            ? describeSession(session, { none: '', turnRunning: running !== null })
            : held
              ? "• starting: Kortix is creating this chat's session"
              : 'none yet: your next message starts one',
        },
      ],
      url: session ? sessionUrl(ctx, session.sessionId) : projectWebUrl(config.FRONTEND_URL, ctx.project.projectId),
      actions: [
        // Bound to the session: a Stop pressed after /new stops nothing.
        ...(session && running ? [{ label: 'Stop', press: { name: 'stop', pick: session.sessionId } } satisfies CommandAction] : []),
        { label: 'New conversation', press: { name: 'new' } },
        { label: 'Change model', press: { name: 'model' } },
        { label: 'Change agent', press: { name: 'agent' } },
      ],
    };
  },

  async stop(ctx) {
    const session = await chatSession(ctx);
    switch (await stopChatTurn(ctx, session)) {
      case 'none':
        return notice('Nothing is running in this chat.');
      case 'starting':
        return notice("Kortix is still starting this chat's session. Send /stop again once the agent is working.");
      case 'elsewhere':
        return notice('This run was started outside this chat, so only Kortix can stop it:', sessionUrl(ctx, session!.sessionId));
      case 'stopped':
        return notice('Stopped. The agent is no longer working on this.');
      case 'unreachable':
        return notice("Kortix could not reach this chat's session to stop the run. Send /stop again in a minute, or /new to start over.");
    }
  },

  async new(ctx, arg) {
    const session = await chatSession(ctx);
    const stop = session ? await stopChatTurn(ctx, session) : 'none';
    if (ctx.questions) await clearQuestionButtons(ctx.questions, ctx.target, 'new_conversation');
    // Whatever the abort answered: the sender asked for a new conversation.
    const { claimHeld } = await forgetChatThread(ctx.target, ctx.createClaim, session?.sessionId);
    // A create in flight can still bind the chat: no promise about the next message.
    const racing = !session && claimHeld;
    const text = [
      stop === 'stopped' && "Stopped the agent's run.",
      racing ? 'Started a new conversation.' : 'Started a new conversation. Your next message goes to a new session.',
      stop === 'starting' && 'The previous session is still starting, and it will still answer your earlier message here.',
      stop === 'unreachable' && 'Kortix could not reach the previous session to stop its run, so it may still post here.',
      stop === 'elsewhere' && 'The previous session is still running a task started outside this chat, and it may post here.',
      racing && 'Kortix was still starting a session for this chat. That session may take your next message; if it does, send /new again.',
      arg && 'The text after /new was not sent. Send it as your next message.',
      session && 'The previous session stays in Kortix:',
    ].filter(Boolean).join(' ');
    return notice(text, session ? sessionUrl(ctx, session.sessionId) : undefined);
  },

  async model(ctx, arg) {
    if (!arg) return PICKERS.model(ctx, 0);
    const { projectId } = ctx.project;
    const [session, selection] = await Promise.all([chatSession(ctx), chatSelection(ctx.settings, projectId)]);
    if (/\s/.test(arg)) return notice(`${clipped(arg, 64)} is not a model id. Send /model to see the list.`);
    if (arg.toLowerCase() === 'default') {
      if (selection) await setChannelModel(ctx.settings, null);
      const pin = pinOf(session);
      if (pin) {
        return notice(`Model for this chat reset to the project default for new sessions. This chat's session keeps ${labelForModelRef(pin)}; send /new to start on the default.`);
      }
      return notice(
        !session && (await threadCreateHeld(ctx.createClaim))
          ? `Model for this chat reset to the project default for new sessions. ${CREATING} model; send /new after it answers to start on the default.`
          : 'Model for this chat reset to the project default.',
      );
    }
    const agent = session?.agentName ?? selection?.agentName ?? null;
    const verdict = await checkChannelModel(await sharedChatScope(ctx.project), arg, { agentGrantEnv: agentGrantEnvFor(projectId, agent) });
    if (!verdict.ok) {
      return notice(
        verdict.reason === 'agent_grant'
          ? `The ${agent || 'default'} agent may not use ${verdict.providerId === 'codex' ? 'ChatGPT connections' : `${verdict.providerId} keys`}. Add ${verdict.envVar} to its secrets in kortix.yaml, or pick another model.`
          : `${modelName(arg)} is not available in this chat. Only models and keys the whole project shares work here. Send /model to see them.`,
      );
    }
    if (!(await ensureChatBinding(ctx.settings, projectId, ctx.label))) return notice(NOT_CONNECTED);
    // No row to write: a disconnect dropped it after the check.
    if (!(await setChannelModel(ctx.settings, verdict.model))) return notice(NOT_CONNECTED);
    if (session) await applyChannelSessionKeys({ sessionId: session.sessionId, keys: verdict.keys, replace: true });
    // A count, never the key names: in a group every member reads the reply.
    const keys = !verdict.keys
      ? ''
      : verdict.keys.secretIds.length === 1
        ? ' It uses a key the project shares.'
        : ` It rotates across ${verdict.keys.secretIds.length} keys the project shares.`;
    // The conversation is one thread of a chat whose settings row it shares (a Telegram forum topic).
    const shared = ctx.settings.channelId !== ctx.target.threadId ? ' It applies to the whole chat, every thread in it included.' : '';
    return notice(`Model for this chat set to ${modelName(verdict.model)}.${keys}${shared} Messages you send after this reply use it.`);
  },

  async agent(ctx, arg) {
    if (!arg) return PICKERS.agent(ctx, 0);
    const { projectId } = ctx.project;
    const refusal = notice(`${clipped(arg, 64)} is not an agent this chat can use. Send /agent to see them.`);
    if (arg.toLowerCase() === 'default') {
      if (await chatSelection(ctx.settings, projectId)) await setChannelAgent(ctx.settings, null);
      return notice('Agent for this chat reset to the project default.');
    }
    // The list a stranger in a group may pick from: never a name a grant restricts, and never one a failed read let through.
    if (/\s/.test(arg) || !(await chatAgents(projectId)).some((a) => a.name === arg)) return refusal;
    if (!(await ensureChatBinding(ctx.settings, projectId, ctx.label))) return notice(NOT_CONNECTED);
    const set = await setChannelAgent(ctx.settings, arg);
    if (!set.ok) return set.reason === 'unknown_agent' ? refusal : notice(NOT_CONNECTED);
    const session = await chatSession(ctx);
    if (!session) {
      return notice(
        (await threadCreateHeld(ctx.createClaim))
          ? `Agent for this chat set to ${arg}. ${CREATING} agent; send /new after it answers to start a session with ${arg}.`
          : `Agent for this chat set to ${arg}. Your next message starts a session with it.`,
      );
    }
    const running = session.agentName || 'default';
    return notice(
      running === arg
        ? `Agent for this chat set to ${arg}. This chat's session already runs it.`
        : `Agent for this chat set to ${arg}. This chat's session keeps ${running}; send /new to start a session with ${arg}.`,
    );
  },
};
