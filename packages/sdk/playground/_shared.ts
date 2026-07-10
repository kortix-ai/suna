/**
 * Shared plumbing for every playground script: client construction, project /
 * session selection, the ensureReady retry loop, and the full
 * send → stream → wait-for-idle → transcript cycle.
 *
 * Credentials come from env — put them in `packages/sdk/.env.local`
 * (gitignored; bun auto-loads it when you run from `packages/sdk/`):
 *
 *   KORTIX_API_URL=http://localhost:8008/v1
 *   KORTIX_API_KEY=kortix_pat_...
 *
 * Optional:
 *   KORTIX_PROJECT_ID / KORTIX_SESSION_ID  — pin a project/session
 *   KORTIX_MODEL=claude-sonnet-4.6         — per-send model override (the local
 *     stack's default model currently 400s on `max_tokens`, so set this)
 */
import {
  ApiError,
  classifyTurn,
  createKortix,
  narrowChatEvent,
} from "../src/index";
import type { MessageWithParts } from "../src/index";

export type KortixClient = ReturnType<typeof createKortix>;
export type SessionHandle = ReturnType<KortixClient["session"]>;

const READY_DEADLINE_MS = 300_000;
const IDLE_TIMEOUT_MS = 300_000;

export function makeKortix(): KortixClient {
  const backendUrl = process.env.KORTIX_API_URL ?? "http://localhost:8008/v1";
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    console.error(
      "Set KORTIX_API_KEY — put it in packages/sdk/.env.local (mint one: user settings → API keys).",
    );
    process.exit(1);
  }
  return createKortix({ backendUrl, getToken: async () => apiKey });
}

/** argv value → KORTIX_PROJECT_ID → first project on the account. */
export async function pickProjectId(
  kortix: KortixClient,
  argvValue?: string,
): Promise<string> {
  const given = argvValue ?? process.env.KORTIX_PROJECT_ID;
  if (given) return given;
  const projects = await kortix.projects.list();
  if (projects.length === 0) {
    console.error(
      "no projects on this account — create one in the web UI first",
    );
    process.exit(1);
  }
  console.log(`no project given — using first project: ${projects[0]!.name}`);
  return projects[0]!.project_id;
}

/** KORTIX_SESSION_ID if set, otherwise create a fresh session in the project. */
export async function pickOrCreateSessionId(
  kortix: KortixClient,
  projectId: string,
  name = "sdk playground",
): Promise<string> {
  const given = process.env.KORTIX_SESSION_ID;
  if (given) return given;
  const created = await kortix.projects.createSession(projectId, { name });
  console.log(`created session ${created.session_id}`);
  return created.session_id;
}

/** Per-send model override from KORTIX_MODEL / KORTIX_MODEL_PROVIDER. */
export function modelOverride():
  | { providerID: string; modelID: string }
  | undefined {
  const modelId = process.env.KORTIX_MODEL;
  if (!modelId) return undefined;
  return {
    providerID: process.env.KORTIX_MODEL_PROVIDER ?? "kortix",
    modelID: modelId,
  };
}

/**
 * `ensureReady()` issues ONE `/start` long-poll and throws a typed
 * `RUNTIME_UNAVAILABLE` ApiError while the sandbox is still provisioning;
 * retrying re-attaches to the same server-side provision.
 */
export async function retryUntilReady<T>(ensure: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await ensure();
    } catch (error) {
      const retryable =
        error instanceof ApiError && error.code === "RUNTIME_UNAVAILABLE";
      if (!retryable || Date.now() - startedAt > READY_DEADLINE_MS) throw error;
      if (attempt % 5 === 1)
        console.log(`  still provisioning (attempt ${attempt}) — retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

export interface TurnResult {
  assistantReplied: boolean;
  timedOut: boolean;
  sessionError: unknown;
  transcript: string[];
}

/**
 * The full chat cycle against one session: ready (with retry) → connect the
 * stream BEFORE sending → send → wait for `session.idle` → render the
 * transcript with `classifyTurn`.
 */
export async function sendAndWait(
  session: SessionHandle,
  prompt: string,
  opts?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
    quiet?: boolean;
  },
): Promise<TurnResult> {
  const log = opts?.quiet ? () => {} : console.log;

  log("readying session (cold boot provisions a sandbox — can take a while)…");
  const { opencodeSessionId } = await retryUntilReady(() =>
    session.ensureReady(),
  );
  log(`✓ ready — opencode session ${opencodeSessionId}`);

  let resolveIdle: () => void;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  let sessionError: unknown = null;

  const handle = await session.stream({
    onEvent: (event) => {
      const narrowed = narrowChatEvent(event);
      if (!narrowed) return;
      log(`· ${narrowed.type}`);
      if (narrowed.type === "session.error") {
        sessionError = narrowed.error;
        console.error("session error:", narrowed.error);
      }
      if (
        narrowed.type === "session.idle" &&
        narrowed.sessionID === opencodeSessionId
      ) {
        resolveIdle();
      }
    },
  });
  log("✓ stream connected");

  const sendOpts: {
    model?: { providerID: string; modelID: string };
    agent?: string;
  } = {};
  if (opts?.model) sendOpts.model = opts.model;
  if (opts?.agent) sendOpts.agent = opts.agent;
  log(
    `sending: ${prompt}${opts?.model ? ` (model: ${opts.model.modelID})` : ""}${opts?.agent ? ` (agent: ${opts.agent})` : ""}`,
  );
  await session.send(
    prompt,
    Object.keys(sendOpts).length ? sendOpts : undefined,
  );
  log("✓ sent — waiting for session.idle…");

  // Race idle vs timeout — and CANCEL the losing timer: a pending setTimeout
  // keeps the bun process alive, which made every chat script sit idle for
  // the full 5 minutes after finishing before it could exit.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), IDLE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timeoutHandle);
  handle.close();

  const result = await session.runtime.session.messages({
    sessionID: opencodeSessionId,
  });
  const messages = (result.data ?? []) as MessageWithParts[];
  const transcript: string[] = [];
  let assistantReplied = false;
  for (const message of messages) {
    for (const part of classifyTurn(message).parts) {
      if (part.kind === "text") {
        if (message.info.role === "assistant" && part.text.trim())
          assistantReplied = true;
        transcript.push(`[${message.info.role}] ${part.text}`);
      }
    }
  }
  return { assistantReplied, timedOut, sessionError, transcript };
}

/** Print a TurnResult and exit non-zero if the turn did not produce a reply. */
export function reportTurn(label: string, turn: TurnResult): void {
  console.log("\n--- transcript ---");
  for (const line of turn.transcript) console.log(line);
  if (turn.timedOut) {
    console.log(`\n✗ ${label}: no session.idle before timeout`);
    process.exit(1);
  }
  if (!turn.assistantReplied) {
    console.log(`\n✗ ${label}: turn finished but the assistant never replied`);
    if (turn.sessionError)
      console.log("  cause: the session.error above (LLM/gateway failure)");
    process.exit(1);
  }
  console.log(`\n✓ ${label} passed end to end`);
  // Explicit exit so lingering stream/reconnect timers can never hold the
  // process open after a successful turn.
  process.exit(0);
}

/** Uniform failure wrapper so every script exits 1 with a labelled error. */
export function run(label: string, main: () => Promise<void>): void {
  main().catch((error) => {
    console.error(`✗ ${label} FAILED`);
    console.error(error);
    process.exit(1);
  });
}
