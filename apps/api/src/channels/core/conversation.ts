/**
 * The conversation core: how one admitted chat message reaches a session.
 *
 * A chat platform plugs in as a `ChannelPort`: what the platform does for the
 * core, addressed by a `ChannelTarget` (one conversation). The adapter hands
 * the core one `ChannelMessage` per inbound message: its target, its persisted
 * keys, the follow-up text and how a new session would start. The adapter
 * keeps what only its platform has: webhook verification and intake, the
 * sender gate, commands, typing, prompts and the wording of every notice.
 *
 *   a message whose create started → nothing: the lifecycle delivers it (a retry)
 *   a known thread       → a follow-up into its session
 *   its session is gone  → forget the thread, start a new session ("revived")
 *   a new thread         → claim the first create, start one session bound to it;
 *                          a racing message waits for that session and follows up
 *   a message's files    → read after the retry guard and attached to its prompt (ChannelFile)
 *
 * A platform adapter supplies its port and keeps its own intake. Adapters that
 * predate the core still route themselves.
 * Session-addressed notices (a failed run, a failed start) go through session-notice.ts.
 * The agent's questions (post, buttons, taps) go through questions.ts.
 */
import { chatEventDedup, projectSessions } from '@kortix/db';
import type { CHANNEL_PLATFORMS } from '@kortix/manifest-schema';
import { isModelNativeAttachmentMime } from '@kortix/shared';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import { createCommandStatus, createSession, deliverThroughQueue, resolveProjectAutomationActor } from '../../projects/surface';
import { db } from '../../shared/db';
import { channelTurnModel, modelReadsImages, NO_VISION_NOTE, promptModelOverride } from '../vision-model';
import type { RuntimeQuestion, TurnErrorCode } from '@kortix/api-contract/transcript';
import type { ConnectorPrincipal } from '../../connectors/router-contract';
import type { QuestionPort } from './questions';
import {
  type ChatThreadKey,
  claimThreadCreate,
  dropChatThread,
  findChatThread,
  releaseThreadCreate,
  touchChatThread,
} from './threads';

type CreateError = NonNullable<Awaited<ReturnType<typeof createSession>>['error']>;

/** `chat_threads.platform` = `metadata.source` = the lifecycle `source` of a channel session. */
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/** The error detail a sandbox relays when a turn ends in an error. */
export interface TurnErrorInfo {
  /** The runtime's error name, e.g. `APIError` / `ProviderAuthError` / `MessageAbortedError`. */
  name?: string;
  message?: string;
  /** Upstream HTTP status for an `APIError` (e.g. 402 = credits, 429 = rate limit). */
  statusCode?: number;
  /** The runtime's own transient/permanent signal. */
  isRetryable?: boolean;
  /** Names the provider in the copy (`ProviderAuthError`). */
  providerID?: string;
  /** The daemon's classification, when it sends one. */
  code?: TurnErrorCode;
}

/** One conversation, and the inbound message an answer anchors to. */
export interface ChannelTarget extends ChatThreadKey {
  platform: ChannelPlatform;
  /** Follow-ups are confined to it; ports read the install's secrets with it. */
  projectId: string;
  /**
   * The inbound message a notice answers (the platform's message id).
   * Absent on a target found from a session (session-notice.ts): `chat_threads`
   * keeps no message id, so that notice is posted unanchored.
   */
  messageId?: string;
}

/** An outcome the agent will not report itself. The port words it, or stays silent. */
export type ChannelNotice =
  /** The create went to the lifecycle queue; its drain binds the thread and delivers the prompt. */
  | { kind: 'create_pending' }
  /** Last attempt: another message's create still holds the thread. */
  | { kind: 'create_in_flight' }
  /** The create failed for good; the thread is free again. */
  | { kind: 'create_failed'; error: CreateError }
  /** Last attempt: the thread's session refused the message (a failed session). */
  | { kind: 'follow_up_failed' }
  /**
   * Session-addressed: a root turn closed in a non-abort error that no live
   * channel turn carried (channels/turn-relay.ts). `promptSource`: the lifecycle source of the prompt the
   * turn answered, when known; a turn another surface prompted (the web, a
   * reminder) is not the chat's to hear.
   */
  | { kind: 'run_failed'; sessionId: string; error?: TurnErrorInfo; promptSource?: string | null }
  /**
   * Session-addressed: the session's sandbox failed to start for a reason a retry
   * does not clear, and the session is `failed`. `reason`: the classified
   * user-facing cause, or null when only internal text exists.
   */
  | { kind: 'start_failed'; sessionId: string; reason: string | null }
  /**
   * Session-addressed: the sandbox failed to start for a reason the provider may
   * clear (capacity, a rate limit); the lifecycle retries it for a few minutes.
   * `reason`: the classified user-facing cause. Told once per session.
   */
  | { kind: 'start_retrying'; sessionId: string; reason: string };

/** The notices a port receives with a target found from a session (session-notice.ts). */
export type SessionNotice = Extract<ChannelNotice, { sessionId: string }>;

/**
 * What happens to a message in a thread whose session exists: deliver it,
 * refuse it (the port logs why), or restart the thread (forget its session
 * and start a new one, which knows it is a revival).
 */
export type FollowUpVerdict = 'deliver' | 'refuse' | 'restart';

/** An agent question addressed by session (session-notice.ts `postSessionQuestion`, questions.ts `postQuestion`). */
export interface SessionQuestion {
  sessionId: string;
  /** The stored question (`session_pending_questions.id`) a button answers. */
  pendingId: string;
  questions: RuntimeQuestion[];
  /** The agent's connector principal: a post stands in for its own call, and runs only where that call would. */
  principal: ConnectorPrincipal;
}

/** What one chat platform does for the core. */
export interface ChannelPort {
  /** Tell the conversation an outcome. Send errors are logged, not thrown. */
  notify(target: ChannelTarget, notice: ChannelNotice): Promise<void>;
  /** Present: the platform shows the agent's questions (questions.ts). */
  questions?: QuestionPort;
  /** Runs before every follow-up into an existing session; absent = deliver. */
  prepareFollowUp?(target: ChannelTarget, thread: { sessionId: string; projectId: string }): Promise<FollowUpVerdict>;
}

/** One verified, deduped, sender-gated inbound message. */
export interface ChannelMessage {
  target: ChannelTarget;
  /**
   * Persisted strings, supplied by the adapter so the core never changes one.
   * The lifecycle keeps both idempotency keys forever: a new format for a
   * message already in flight delivers it twice.
   */
  keys: {
    /** `deliverThroughQueue` idempotency key of this message. */
    followUp: string;
    /** `createSession` idempotency key of this message. */
    create: string;
    /** `chat_event_dedup` key that lets one message per thread create its session. */
    createClaim: string;
  };
  followUp: { text: string };
  /** The message's own files, never a quoted message's. Read once per attempt, after the retry guard, on the way into a session. */
  files?: readonly ChannelFile[];
  /** How the thread's session starts. `revived`: its earlier session is gone. Null drops the message (the adapter logs why). */
  plan(revived: boolean): Promise<ChannelSessionPlan | null>;
}

/** One file of an inbound message. The adapter lists it from the stored event, with no network call. */
export interface ChannelFile {
  /** The platform's name, or the adapter's (`photo.jpg`). The core keeps letters, digits, `.`, `_` and `-`. */
  filename: string;
  /** The declared type. The core keeps a valid bare `type/subtype`, else `application/octet-stream`. */
  mime: string;
  /** The size the platform states. Over the room left in the message, `read` never runs. */
  size?: number;
  /**
   * The bytes, at most `maxBytes`, or why there are none: the agent is told, and the text still goes.
   * Throws only when the platform does not answer: the core retries the message, and on its last
   * attempt sends it without the file. Never put a platform URL or a credential in the bytes.
   */
  read(maxBytes: number): Promise<Uint8Array | 'too_large' | 'unavailable'>;
}

/**
 * All the file bytes one message attaches. They ride base64 in the queued prompt row (~10.4 MiB at
 * this cap), under the 12 MiB a web prompt's `data:` parts may hold (session-lifecycle/prompt-parts.ts).
 */
// ponytail: the bytes live in Postgres (the queued row; on a new chat, the create command too).
// Upgrade: store a follow-up's files with sessionAttachmentStore and send the reference (50 MiB).
export const CHANNEL_FILES_MAX_BYTES = 8 * 1024 * 1024;

export interface ChannelSessionPlan {
  project: Parameters<typeof createSession>[0]['project'];
  /** Who the session runs as. Omitted: the project's automation actor. */
  userId?: string;
  visibility: 'project' | 'private';
  /** The core adds `base_ref` first. */
  body: Record<string, unknown>;
  /** The platform block; the core adds `source` first. */
  metadata: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  mayManageSystemConnections?: boolean;
  /** The first prompt, delivered once the session is bound to the thread. */
  prompt: string;
}

/** Up to 8 s for a racing message's create to bind the thread. */
const CREATE_WAIT_POLL_MS = 250;
const CREATE_WAIT_POLLS = 32;

const defaultLifecycle = {
  createCommandStatus,
  createSession,
  deliverThroughQueue,
  resolveProjectAutomationActor,
  imageTurnModel,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let lifecycle = defaultLifecycle;

export function setChannelLifecycleForTest(overrides: Partial<typeof defaultLifecycle>): void {
  lifecycle = { ...defaultLifecycle, ...overrides };
}

export function resetChannelLifecycleForTest(): void {
  lifecycle = defaultLifecycle;
}

/**
 * Route one admitted message. Throws to ask the transport for a retry, never
 * on `finalAttempt`: the conversation is told there instead (a transport
 * without retries passes `finalAttempt: true`).
 */
export async function routeChannelMessage(
  port: ChannelPort,
  message: ChannelMessage,
  run: { finalAttempt: boolean },
): Promise<void> {
  const { target, keys } = message;
  // A retry of a message whose create already started (its replica died, a
  // write after the bind threw, or its job was claimed again during a long
  // create): the lifecycle delivers its first prompt. Routing it again would
  // follow up under another key, and the message would arrive twice.
  const create = await lifecycle.createCommandStatus(keys.create, target.projectId);
  if (createStarted(create)) {
    logger.info('[channel] create already started; the retry routes nothing', {
      platform: target.platform,
      projectId: target.projectId,
      status: create,
    });
    return;
  }
  // A message's files: read once per attempt, after the retry guard, and only on the way into a session.
  let reading: Promise<MessageFiles> | undefined;
  const files = () => (reading ??= readMessageFiles(target, message.files ?? [], run));
  const existing = await findChatThread(target);
  if (existing) {
    if ((await followUp(port, message, existing, run, files)) !== 'no-session') return;
    // Its session is gone, or it belongs to another project. Drop only that
    // mapping: a racing message may have bound a new session since our read.
    await dropChatThread(target, existing.sessionId);
  }

  const plan = await message.plan(existing !== null);
  if (!plan) return;
  const userId = plan.userId ?? (await lifecycle.resolveProjectAutomationActor(plan.project.accountId));
  if (!userId) {
    logger.warn('[channel] no automation actor for the project', { platform: target.platform, projectId: target.projectId });
    return;
  }
  // Before the claim: a read that throws holds no claim, and a racing message's 8 s wait does not grow.
  const first = await withFiles(plan.prompt, await files(), async () => ({
    projectId: target.projectId,
    accountId: plan.project.accountId,
    userId,
    currentModel: modelPin(plan.body.opencode_model),
    visibility: plan.visibility,
  }));

  const claim = await claimThreadCreate(keys.createClaim);
  if (!claim) {
    const thread = await waitForThreadSession(target);
    if (thread) {
      await followUpJustBound(port, message, thread, run, files);
      return;
    }
    if (!run.finalAttempt) throw new Error(`${target.platform} thread create in flight`);
    logger.warn('[channel] a racing create never bound the thread', { platform: target.platform, projectId: target.projectId });
    await port.notify(target, { kind: 'create_in_flight' });
    return;
  }
  // A racing message may have bound the thread and released its claim between
  // our lookup and our claim (a create binds before it releases): follow up
  // into that session instead of starting a second one.
  const bound = await findChatThread(target);
  if (bound) {
    await releaseThreadCreate(keys.createClaim, claim);
    await followUpJustBound(port, message, bound, run, files);
    return;
  }

  let result: Awaited<ReturnType<typeof createSession>>;
  try {
    result = await lifecycle.createSession({
      source: target.platform,
      project: plan.project,
      userId,
      requestingPrincipalType: 'human',
      body: { base_ref: plan.project.defaultBranch, ...plan.body },
      visibility: plan.visibility,
      metadata: { source: target.platform, ...plan.metadata },
      ...(plan.extraEnvVars ? { extraEnvVars: plan.extraEnvVars } : {}),
      ...(plan.mayManageSystemConnections ? { mayManageSystemConnections: true } : {}),
      queuePolicy: 'on_backpressure',
      idempotencyKey: keys.create,
      postCreate: [
        {
          type: 'bind_chat_thread',
          platform: target.platform,
          workspaceId: target.workspaceId,
          threadId: target.threadId,
          createClaim: { key: keys.createClaim, token: claim.toISOString() },
        },
        { type: 'deliver_prompt', source: target.platform, ...first, userId },
      ],
    });
  } catch (error) {
    // Free the thread so the transport's retry creates under the same key,
    // instead of waiting for a thread this attempt never bound. Unless the
    // lifecycle holds the create: the retry returns above, and the bind (or
    // the create's dead letter) frees the claim, so no other message starts a
    // second session while the create runs. A failed read keeps it: the claim
    // expires.
    // ponytail: a create whose replica dies keeps the claim only for its TTL
    // (10 min); the lifecycle reclaims that create after its lease and grace
    // (5 + 5 min). A message in the gap can start a second session. Upgrade:
    // refresh the claim from the create's lease heartbeat.
    const owner = await lifecycle.createCommandStatus(keys.create, target.projectId).catch(() => 'unknown' as const);
    if (owner !== 'unknown' && !createStarted(owner)) await releaseThreadCreate(keys.createClaim, claim);
    throw error;
  }

  if (result.sessionId && !result.error) {
    // The create bound the thread and freed the claim (a deduped older create
    // may carry another token, so free ours too).
    await releaseThreadCreate(keys.createClaim, claim);
    return;
  }
  if (!result.error || result.requeued) {
    // The drain binds the thread, then frees this claim with its token.
    await port.notify(target, { kind: 'create_pending' });
    return;
  }
  // Final for this message: free the thread so a corrected re-send starts at once.
  logger.warn('[channel] session create failed', {
    platform: target.platform,
    projectId: target.projectId,
    status: result.error.status,
    code: result.error.body.code,
  });
  await releaseThreadCreate(keys.createClaim, claim);
  await port.notify(target, { kind: 'create_failed', error: result.error });
}

/**
 * A follow-up into a thread a racing message just bound. When that session
 * cannot take it (it is gone, or the port restarts the thread), retry the
 * message: the retry finds the thread and starts it over. The last attempt
 * drops it.
 */
async function followUpJustBound(
  port: ChannelPort,
  message: ChannelMessage,
  thread: { sessionId: string; projectId: string },
  run: { finalAttempt: boolean },
  files: () => Promise<MessageFiles>,
): Promise<void> {
  if ((await followUp(port, message, thread, run, files)) !== 'no-session') return;
  if (!run.finalAttempt) throw new Error(`${message.target.platform} thread session cannot take the message`);
  logger.warn('[channel] the thread session a racing message bound cannot take this one; dropped', {
    platform: message.target.platform,
    sessionId: thread.sessionId,
  });
}

/** A create the lifecycle owns: it binds the thread and delivers the first prompt. */
function createStarted(status: Awaited<ReturnType<typeof createCommandStatus>>): boolean {
  return status === 'queued' || status === 'running' || status === 'succeeded';
}

/** Forget a conversation (a `/new` command): the next message starts a new session. */
export async function forgetChatThread(target: ChannelTarget, createClaim: string): Promise<void> {
  await dropChatThread(target);
  // Its create claim too, or the next message waits on it. A create still in
  // flight may then race that message: two sessions, for a reset the sender asked for.
  await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, createClaim));
}

async function followUp(
  port: ChannelPort,
  { target, keys, followUp: { text } }: ChannelMessage,
  thread: { sessionId: string; projectId: string },
  run: { finalAttempt: boolean },
  files: () => Promise<MessageFiles>,
): Promise<Awaited<ReturnType<typeof deliverThroughQueue>> | 'refused'> {
  const verdict = port.prepareFollowUp ? await port.prepareFollowUp(target, thread) : 'deliver';
  if (verdict === 'refuse') return 'refused';
  if (verdict === 'restart') return 'no-session';
  const prompt = await withFiles(text, await files(), () => sessionImageTurn(target.projectId, thread.sessionId));
  const outcome = await lifecycle.deliverThroughQueue({
    source: target.platform,
    idempotencyKey: keys.followUp,
    projectId: target.projectId,
    sessionId: thread.sessionId,
    ...prompt,
  });
  if (outcome === 'delivered' || outcome === 'queued') await touchChatThread(target);
  if (outcome === 'failed') {
    if (!run.finalAttempt) throw new Error(`${target.platform} follow-up failed`);
    logger.warn('[channel] the thread session refused the message', { platform: target.platform, sessionId: thread.sessionId });
    await port.notify(target, { kind: 'follow_up_failed' });
  }
  return outcome;
}

async function waitForThreadSession(thread: ChatThreadKey): Promise<{ sessionId: string; projectId: string } | null> {
  for (let poll = 0; ; poll++) {
    const row = await findChatThread(thread);
    if (row) return row;
    if (poll === CREATE_WAIT_POLLS) return null;
    await lifecycle.sleep(CREATE_WAIT_POLL_MS);
  }
}

type PromptPart = NonNullable<Parameters<typeof deliverThroughQueue>[0]['parts']>[number]; // PromptPartWire is not on projects/surface.ts
type Prompt = Pick<Parameters<typeof deliverThroughQueue>[0], 'text' | 'parts' | 'overrides'>;
interface MessageFiles { parts: PromptPart[]; notes: string[]; hasImage: boolean; hasAudio: boolean }
/** Who an image turn runs as, and the model its session pins. */
interface ImageTurn { projectId: string; accountId: string; userId: string | null; currentModel: string | null; visibility: string; sessionId?: string }

const CAP_MB = CHANNEL_FILES_MAX_BYTES / (1024 * 1024);
/** Nothing in the sandbox or the gateway turns speech into text yet. */
const NO_SPEECH_NOTE = 'A recording is attached. No speech-to-text tool is installed here, so you cannot listen to it: tell the sender, and ask them to type the message.';

/** Letters, digits, `.`, `_`, `-`: the name reaches a workspace path and the lines Kortix vouches for. */
const fileName = (name: string) =>
  Array.from(name.normalize('NFC').replace(/[^\p{L}\p{N}._-]/gu, '_')).slice(0, 100).join('') || 'file';

/** `type/subtype`, lower case, no parameters: `parseStagedPromptDataUrl` needs the URL's type and the part's to match. */
function bareMime(mime: string): string {
  const bare = mime.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(bare) ? bare : 'application/octet-stream';
}

const modelPin = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Each file as a `data:` part, or a note that says why it is missing. Throws to retry when a platform does not answer. */
async function readMessageFiles(target: ChannelTarget, files: readonly ChannelFile[], run: { finalAttempt: boolean }): Promise<MessageFiles> {
  const read: MessageFiles = { parts: [], notes: [], hasImage: false, hasAudio: false };
  let room = CHANNEL_FILES_MAX_BYTES;
  for (const file of files) {
    const filename = fileName(file.filename);
    const mime = bareMime(file.mime);
    let bytes: Awaited<ReturnType<ChannelFile['read']>> = 'too_large';
    if (file.size === undefined || file.size <= room) {
      try {
        bytes = await file.read(room);
      } catch (error) {
        // Never the adapter's error: its message may name a URL that carries a credential.
        if (!run.finalAttempt) throw new Error(`${target.platform} file download unreachable`);
        logger.warn('[channel] a file did not download on the last attempt; the message goes without it', {
          platform: target.platform,
          projectId: target.projectId,
          error: error instanceof Error ? error.name : 'unknown',
        });
        bytes = 'unavailable';
      }
    }
    if (typeof bytes !== 'string' && bytes.byteLength > room) bytes = 'too_large';
    if (typeof bytes === 'string') {
      read.notes.push(bytes === 'too_large'
        ? `The file "${filename}" was not attached: a chat message brings at most ${CAP_MB} MB of files. Tell the sender, and ask for a smaller file or the text.`
        : `The file "${filename}" was not attached: Kortix could not download it. Ask the sender to send it again.`);
      continue;
    }
    room -= bytes.byteLength;
    read.parts.push({ type: 'file', mime, filename, url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
    read.hasImage ||= mime.startsWith('image/') && isModelNativeAttachmentMime(mime);
    read.hasAudio ||= mime.startsWith('audio/');
  }
  return read;
}

/**
 * The model of a turn whose message carries an image (vision-model.ts), and whether no model in reach
 * reads it. pi gives an image only to a model that reads images, so the gateway's image reroute never
 * sees one: the core picks before the turn.
 */
async function imageTurnModel(turn: ImageTurn): Promise<{ model: string | null; blind: boolean }> {
  const model = await channelTurnModel({
    projectId: turn.projectId,
    accountId: turn.accountId,
    userId: turn.userId,
    currentModel: turn.currentModel,
    hasImage: true,
    // A shared session counts no one's personal keys, as the gateway resolves it.
    personalUserId: turn.visibility === 'private' ? turn.userId : null,
    // ponytail: codex replacements fail closed. The agent-grant reader (model-access.ts
    // `agentGrantEnvFor`) imports Slack code. Upgrade: move it into vision-model.ts.
    agentGrantEnv: async () => [],
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
  });
  return { model, blind: !model && !modelReadsImages(turn.projectId, turn.currentModel ?? platformDefaultModelId()) };
}

/** An existing session's image turn. Null: the session is gone (the delivery then answers `no-session`). */
async function sessionImageTurn(projectId: string, sessionId: string): Promise<ImageTurn | null> {
  const [row] = await db
    .select({
      accountId: projectSessions.accountId,
      createdBy: projectSessions.createdBy,
      visibility: projectSessions.visibility,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  return {
    projectId,
    sessionId,
    accountId: row.accountId,
    visibility: row.visibility,
    userId: row.createdBy ?? (await lifecycle.resolveProjectAutomationActor(row.accountId)),
    currentModel: modelPin((row.metadata as Record<string, unknown> | null)?.opencode_model),
  };
}

/**
 * The prompt for a message. With no file it is the text alone, as before. Otherwise the notes follow
 * the text, then one text part precedes the files. Text first: the session view reads the header at
 * the start. pi joins text parts with nothing between them (runtime.ts:188), so the part ends with a line break.
 */
async function withFiles(text: string, files: MessageFiles, turn: () => Promise<ImageTurn | null>): Promise<Prompt> {
  if (!files.parts.length && !files.notes.length) return { text };
  const lines = [...files.notes, ...(files.hasAudio ? [NO_SPEECH_NOTE] : [])].map((note) => `- ${note}`);
  let overrides: Prompt['overrides'];
  if (files.hasImage) {
    const imageTurn = await turn();
    const pick = imageTurn ? await lifecycle.imageTurnModel(imageTurn) : { model: null, blind: false };
    if (pick.model) overrides = { model: promptModelOverride(pick.model) };
    if (pick.blind) lines.push(NO_VISION_NOTE);
  }
  const full = [text, ...lines].join('\n');
  return {
    text: full,
    ...(files.parts.length ? { parts: [{ type: 'text', text: `${full}\n` }, ...files.parts] } : {}),
    ...(overrides ? { overrides } : {}),
  };
}
