/**
 * The chat TUI orchestrator — the only stateful file in `chat/`.
 *
 * It wires four things that each know nothing about the others: the SSE
 * transport (`../api/sandbox-events.ts`), the pure reducer (`transcript.ts`),
 * the single terminal writer (`render.ts`), and the composer (`input.ts`).
 *
 * Everything it does maps to a call that already exists (R-43): submit is
 * `prompt_async`, interrupt is `POST /session/:id/abort`, approve is
 * `/permission/:id/reply`, answer is `/question/:id/reply`, history is
 * `GET /session/:id/message`. The TUI adds no capability — it adds a way of
 * experiencing capabilities that are already reachable from the CLI, the API
 * and the SDK.
 *
 * It is a CLIENT onto a cloud session, never a second way to BE the agent. The
 * session keeps running when you detach; that is stated on screen on the way
 * in and on the way out.
 */

import { randomUUID } from 'node:crypto';

import type { SandboxEvent } from '../api/sandbox-events.ts';
import {
  newPromptMessageId,
  type OpencodeMessageWithParts,
  type OpencodePromptPart,
} from '../api/sandbox-proxy.ts';
import { C } from '../style.ts';
import { narrowChatEvent, type ChatEvent } from './events.ts';
import { createComposer } from './input.ts';
import type { Renderer } from './render.ts';
import {
  applyEvent,
  createTranscriptState,
  markWorking,
  reconcile,
  statusText,
  suppressMessage,
  type RenderOp,
  type TranscriptState,
} from './transcript.ts';

/** Rotating status marker. Same glyphs `sessions status` already uses for a
 *  provisioning box, so "something is happening" looks the same everywhere. */
const SPINNER = ['◐', '◓', '◑', '◒'] as const;
const SPINNER_INTERVAL_MS = 120;
/** A second Ctrl-C inside this window detaches instead of interrupting again. */
const DOUBLE_INTERRUPT_MS = 2_000;
const HISTORY_LIMIT = 30;
const PROMPT = `${C.green}${C.bold}you${C.reset} `;

export interface ChatTuiOc {
  listMessages: (sessionId: string, limit?: number) => Promise<OpencodeMessageWithParts[]>;
  submitPrompt: (
    sessionId: string,
    parts: OpencodePromptPart[],
    extra?: { agent?: string },
    idempotencyKey?: string,
    messageID?: string,
  ) => Promise<string>;
  sendPrompt: (
    sessionId: string,
    parts: OpencodePromptPart[],
    extra?: { agent?: string },
    timeoutMs?: number,
    idempotencyKey?: string,
  ) => Promise<{ info: unknown; parts: unknown[] }>;
  abortSession: (sessionId: string) => Promise<boolean>;
  replyPermission: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ) => Promise<boolean>;
  replyQuestion: (requestId: string, answers: string[][]) => Promise<boolean>;
}

export interface StreamHandlers {
  onEvent: (event: SandboxEvent) => void;
  onGapRehydrate: (gapMs: number) => void;
  onConnected: () => void;
  onReconnecting: (delayMs: number) => void;
  onParked: () => void;
}

export interface ChatTuiPickItem {
  value: string;
  label: string;
  sublabel?: string;
}

export interface ChatTuiDeps {
  oc: ChatTuiOc;
  renderer: Renderer;
  /** Opens the event stream. Never called on the poll transport. */
  openStream: (handlers: StreamHandlers) => { close: () => void };
  /** Binds a keystroke source; the returned function unbinds it. */
  attachInput: (onData: (chunk: Buffer | string) => void) => () => void;
  /** Binds a resize source; the returned function unbinds it. */
  onResize: (handler: () => void) => () => void;
  /** Inline picker for permissions/questions — the CLI's own `selectFromList`. */
  select: (opts: { title: string; items: ChatTuiPickItem[] }) => Promise<string | null>;
  now: () => number;
  setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  env: (name: string) => string | undefined;
}

export interface ChatTuiOptions {
  /** Kortix session id — what `kortix chat <id>` takes to reattach. */
  sessionId: string;
  /** Display name for the header. */
  label: string;
  agentName: string;
  /** The OpenCode session INSIDE the sandbox. */
  ocSessionId: string;
  /** Agent override for each turn, when the caller pinned one. */
  agent?: string;
  verbose: boolean;
  /**
   * `poll` is the honest degradation for `acp_runtime` projects: the OpenCode
   * event bus stops being the source of truth there
   * (`packages/sdk/src/core/session/runtime-transport.ts` sets
   * `streamOpenCodeEvents: false`), so streaming would render an empty
   * transcript forever. Poll mode says `polling` in the status line instead of
   * pretending to stream.
   */
  transport: 'stream' | 'poll';
  deps: ChatTuiDeps;
}

type Connection = 'connecting' | 'connected' | 'reconnecting' | 'parked' | 'polling';

export async function runChatTui(opts: ChatTuiOptions): Promise<number> {
  const { deps, ocSessionId } = opts;
  const { oc, renderer } = deps;
  const extra = opts.agent ? { agent: opts.agent } : undefined;
  const reattach = `${C.cyan}kortix chat ${opts.sessionId}${C.reset}`;

  let state: TranscriptState = createTranscriptState(opts.verbose);
  let toolLines: string[] = [];
  let connection: Connection = opts.transport === 'poll' ? 'polling' : 'connecting';
  let turnActive = false;
  /** A message typed during a turn, waiting for `session.idle` (F5). */
  let queued: string | null = null;
  let spinner = 0;
  /** -Infinity, not 0: on a clock that starts near zero, 0 would make the very
   *  first Ctrl-C look like the second one and detach instead of interrupting. */
  let lastInterruptAt = Number.NEGATIVE_INFINITY;
  let finished = false;

  /**
   * TODO(verify-live): whether OpenCode accepts a second `prompt_async` while a
   * turn is running is UNVERIFIED — it needs one live sandbox to settle. Until
   * then the default buffers locally and sends on idle, because guessing wrong
   * either drops the user's message or double-runs a turn. Flip this env var
   * after that single live test.
   */
  const sendDuringTurn = deps.env('KORTIX_CHAT_SEND_DURING_TURN') === '1';

  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const composer = createComposer({
    onSubmit: (text) => void handleSubmit(text),
    onInterrupt: () => handleInterrupt(),
    onEof: () => finish(0),
    onChange: () => redraw(),
  });

  function connectionNote(): string | null {
    switch (connection) {
      case 'reconnecting':
        // Never an error, never a stack trace — the turn is not lost.
        return `${C.dim}reconnecting…${C.reset}`;
      case 'parked':
        return `${C.yellow}stream lost${C.reset}`;
      case 'polling':
        return `${C.dim}polling${C.reset}`;
      default:
        return null;
    }
  }

  function statusLine(): string | null {
    const activity = statusText(state);
    const bits: string[] = [];
    if (activity) {
      // A spinner ONLY when nothing is streaming (F2): once tokens flow, the
      // text itself is the progress indicator.
      const mark = state.streamingText ? `${C.faded}·${C.reset}` : `${C.yellow}${SPINNER[spinner % SPINNER.length]}${C.reset}`;
      bits.push(`${mark} ${C.dim}${activity}${C.reset}`);
    }
    if (queued) bits.push(`${C.faded}⏎ queued${C.reset}`);
    const note = connectionNote();
    if (note) bits.push(note);
    return bits.length > 0 ? `  ${bits.join('  ')}` : null;
  }

  function redraw(): void {
    const lines = [...toolLines];
    const status = statusLine();
    if (status) lines.push(status);
    lines.push(...composer.lines(PROMPT));
    const col = composer.cursorColumn(PROMPT);
    renderer.setTail(lines, col ?? undefined);
  }

  function applyOps(ops: RenderOp[]): void {
    for (const op of ops) {
      if (op.kind === 'append') renderer.append(op.text);
      else if (op.kind === 'commit') renderer.commit(op.lines);
      else if (op.kind === 'tail') toolLines = op.lines;
      else if (op.kind === 'bell') renderer.bell();
    }
    redraw();
  }

  function dispatch(event: ChatEvent): void {
    const result = applyEvent(state, event);
    state = result.state;
    applyOps(result.ops);
  }

  function echoUser(text: string): void {
    renderer.commit(['', `${C.green}${C.bold}you${C.reset}`, ...text.split('\n').map((l) => `  ${l}`)]);
  }

  async function handleSubmit(text: string): Promise<void> {
    echoUser(text);
    if (turnActive && !sendDuringTurn) {
      // Buffer locally rather than gamble on mid-turn submission.
      queued = text;
      redraw();
      return;
    }
    await sendToAgent(text);
  }

  async function sendToAgent(text: string): Promise<void> {
    turnActive = true;
    state = markWorking(state);
    redraw();
    const parts: OpencodePromptPart[] = [{ type: 'text', text }];
    const idempotencyKey = randomUUID();
    try {
      if (opts.transport === 'poll') {
        // No event bus here — block on the existing poll path and render the
        // completed reply, exactly like `kortix sessions chat` does today.
        const reply = await oc.sendPrompt(ocSessionId, parts, extra, undefined, idempotencyKey);
        const result = reconcile(state, [reply as OpencodeMessageWithParts]);
        state = result.state;
        applyOps(result.ops);
        turnActive = false;
        state = { ...state, working: false, streamingText: false, activeTool: null };
        redraw();
        return;
      }
      // The server streams our own user message back on the bus, and it can
      // arrive BEFORE the submit call resolves — so claim the id up front and
      // suppress it before a single byte can be echoed twice.
      const messageID = newPromptMessageId();
      state = suppressMessage(state, messageID);
      await oc.submitPrompt(ocSessionId, parts, extra, idempotencyKey, messageID);
    } catch (err) {
      turnActive = false;
      state = { ...state, working: false, streamingText: false, activeTool: null };
      renderer.commit([`  ${C.red}${(err as Error).message || 'failed to send'}${C.reset}`]);
      redraw();
    }
  }

  function handleInterrupt(): void {
    const now = deps.now();
    const doubled = now - lastInterruptAt < DOUBLE_INTERRUPT_MS;
    lastInterruptAt = now;
    if (doubled) {
      finish(0);
      return;
    }
    if (turnActive) {
      // Interrupt the TURN, not the process — and never leave the remote
      // session wedged because the client walked away.
      void oc.abortSession(ocSessionId).catch(() => {});
      turnActive = false;
      // A queued message was already echoed into scrollback, so dropping it
      // silently leaves a transcript showing a message the agent never saw.
      // Say so, and give it back to the composer rather than losing the typing.
      const dropped = queued;
      queued = null;
      state = { ...state, tools: [], working: false, streamingText: false, activeTool: null };
      toolLines = [];
      renderer.commit([`  ${C.dim}interrupted${C.reset}`]);
      if (dropped) {
        renderer.commit([`  ${C.dim}queued message not sent — restored below${C.reset}`]);
        composer.setText(dropped);
      }
      redraw();
      return;
    }
    if (composer.text().length > 0) {
      composer.clear();
      return;
    }
    renderer.commit([`  ${C.dim}press Ctrl-C again to detach${C.reset}`]);
    redraw();
  }

  async function rehydrate(): Promise<void> {
    // A reconnect without this silently eats the middle of a turn: events
    // emitted during the gap are gone, and only a history read can recover
    // them. Reconcile emits ONLY the unseen suffix, so nothing duplicates.
    try {
      const messages = await oc.listMessages(ocSessionId, HISTORY_LIMIT);
      const result = reconcile(state, messages);
      state = result.state;
      applyOps(result.ops);
    } catch {
      // A failed rehydrate is not fatal — the next one will catch up.
    }
  }

  let detachInput: (() => void) | null = null;

  async function askInline<T extends string>(
    title: string,
    items: ChatTuiPickItem[],
  ): Promise<T | null> {
    // `selectFromList` owns stdin and draws its own frame, so hand the
    // terminal over cleanly and take it back afterwards.
    renderer.clearTail();
    detachInput?.();
    detachInput = null;
    try {
      return (await deps.select({ title, items })) as T | null;
    } finally {
      detachInput = deps.attachInput((chunk) => composer.handleData(chunk));
      redraw();
    }
  }

  async function handlePermission(event: Extract<ChatEvent, { type: 'permission.asked' }>): Promise<void> {
    const scope = event.patterns.length > 0 ? ` · ${event.patterns.join(', ')}` : '';
    const choice = await askInline<'once' | 'always' | 'reject'>(
      `The agent wants ${event.permission}${scope}`,
      [
        { value: 'once', label: 'Allow once' },
        { value: 'always', label: 'Allow for this session' },
        { value: 'reject', label: 'Reject' },
      ],
    );
    const reply = choice ?? 'reject';
    try {
      await oc.replyPermission(event.requestID, reply);
      renderer.commit([`  ${C.faded}${event.permission} · ${reply}${C.reset}`]);
    } catch (err) {
      renderer.commit([`  ${C.red}${(err as Error).message}${C.reset}`]);
    }
    redraw();
  }

  async function handleQuestion(event: Extract<ChatEvent, { type: 'question.asked' }>): Promise<void> {
    const answers: string[][] = [];
    for (const question of event.questions) {
      const items = (question.options ?? []).map((o) => ({
        value: o.value ?? o.label,
        label: o.label,
        sublabel: o.description ?? o.hint,
      }));
      if (items.length === 0) continue;
      const picked = await askInline(question.header || question.question, items);
      answers.push(picked ? [picked] : []);
    }
    try {
      await oc.replyQuestion(event.requestID, answers);
      renderer.commit([`  ${C.faded}answered${C.reset}`]);
    } catch (err) {
      renderer.commit([`  ${C.red}${(err as Error).message}${C.reset}`]);
    }
    redraw();
  }

  function onEvent(raw: SandboxEvent): void {
    const event = narrowChatEvent(raw);
    if (!event) return;
    // The bus is global to the sandbox — ignore other sessions' traffic.
    const sessionID = (event as { sessionID?: string }).sessionID;
    if (sessionID && sessionID !== ocSessionId) return;

    if (event.type === 'permission.asked') {
      void handlePermission(event);
      return;
    }
    if (event.type === 'question.asked') {
      void handleQuestion(event);
      return;
    }
    dispatch(event);
    if (event.type === 'session.idle') {
      turnActive = false;
      // An assistant reply rarely ends in a newline, and `drawTail` refuses to
      // draw while the cursor is mid-line — so without this the composer never
      // reappears and typing shows nothing until the next commit. Reads as a
      // hang; it is the first thing you hit after any normal reply.
      renderer.closeLine();
      const next = queued;
      queued = null;
      if (next) void sendToAgent(next);
      else redraw();
    }
  }

  // ── Terminal lifecycle ───────────────────────────────────────────────────
  let stream: { close: () => void } | null = null;
  let detachResize: (() => void) | null = null;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    if (spinnerTimer) deps.clearInterval(spinnerTimer);
    detachResize?.();
    detachInput?.();
    stream?.close();
    renderer.clearTail();
    renderer.commit([
      '',
      turnActive
        ? `  ${C.dim}Detached. The agent is still working — ${C.reset}${reattach}${C.dim} to reattach.${C.reset}`
        : `  ${C.dim}Detached. The session keeps running — ${C.reset}${reattach}${C.dim} to reattach.${C.reset}`,
      '',
    ]);
    resolveExit(code);
  }

  renderer.commit([
    '',
    `  ${C.dim}Talking to ${C.reset}${C.bold}${opts.label}${C.reset} ${C.faded}(${opts.agentName})${C.reset}`,
    `  ${C.dim}Enter sends · \\ + Enter for a newline · Ctrl-C interrupts the turn · Ctrl-D detaches${C.reset}`,
    `  ${C.dim}The session runs in the cloud — closing this window does not stop it.${C.reset}`,
  ]);

  // History first, so the conversation has context on screen before anything
  // streams into it.
  try {
    const history = await oc.listMessages(ocSessionId, HISTORY_LIMIT);
    const result = reconcile(state, history);
    state = result.state;
    applyOps(result.ops);
  } catch {
    // No history / sandbox still warming — start fresh rather than fail.
  }

  // Open the stream BEFORE the first send so no early event is missed.
  if (opts.transport === 'stream') {
    stream = deps.openStream({
      onEvent,
      onGapRehydrate: () => void rehydrate(),
      onConnected: () => {
        connection = 'connected';
        redraw();
      },
      onReconnecting: () => {
        connection = 'reconnecting';
        redraw();
      },
      onParked: () => {
        connection = 'parked';
        renderer.commit([
          `  ${C.yellow}Lost the event stream. The agent is still working — ${C.reset}${reattach}${C.yellow} to reattach.${C.reset}`,
        ]);
        redraw();
      },
    });
  }

  detachInput = deps.attachInput((chunk) => composer.handleData(chunk));
  detachResize = deps.onResize(() => renderer.handleResize());
  spinnerTimer = deps.setInterval(() => {
    if (!state.working || state.streamingText) return;
    spinner += 1;
    redraw();
  }, SPINNER_INTERVAL_MS);

  redraw();
  return exited;
}
