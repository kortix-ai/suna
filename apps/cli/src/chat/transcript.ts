/**
 * Pure reducer: chat events in, render operations out. No I/O, no cursor
 * movement — it emits styled LINES and TEXT, never escape sequences that move
 * the cursor. `render.ts` is the only thing that knows where the cursor is.
 *
 * The load-bearing invariant is the one the platform already relies on
 * (`packages/sdk/src/browser/stores/sync-store.ts`): `message.part.updated`
 * carries the part's FULL cumulative text every time, and successive frames are
 * MONOTONIC PREFIX GROWTH. So a terminal client keeps a `written` cursor per
 * part and writes `incoming.slice(written.length)`. A frame that is not a
 * prefix extension is stale/out-of-order and is DROPPED — never printed, and
 * never used to rewind, because scrollback cannot be rewound.
 */

import type {
  OpencodeMessageWithParts,
  OpencodePart,
} from '../api/sandbox-proxy.ts';
import { C } from '../style.ts';
import type { ChatEvent, ChatPart, ChatPartState } from './events.ts';

/** What the renderer should do. `append` is raw text (mid-line, token by
 *  token); `commit` is whole lines that become immutable scrollback; `tail` is
 *  the mutable live region; `bell` asks for the terminal's attention. */
export type RenderOp =
  | { kind: 'append'; text: string }
  | { kind: 'commit'; lines: string[] }
  | { kind: 'tail'; lines: string[] }
  | { kind: 'bell' };

export interface ToolEntry {
  key: string;
  name: string;
  status: string;
  detail: string;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  error?: string;
}

export interface TranscriptState {
  /** Per-part cursor: how much of that part's text is already on screen. */
  written: Record<string, string>;
  /** Tool parts still in flight — this IS the live tail's content. */
  tools: ToolEntry[];
  /** Roles learned from `message.updated`, so a user part is never echoed. */
  roles: Record<string, string>;
  /** Messages this client itself submitted — already on screen, never echo. */
  suppressed: Record<string, true>;
  /** Which message the scrollback cursor is inside, so a turn gets exactly one
   *  header no matter how many parts it streams. */
  currentMessageID: string | null;
  /** True while assistant text is arriving. Suppresses the spinner (F2). */
  streamingText: boolean;
  /** True between submit and `session.idle`. */
  working: boolean;
  /** Tool running right now, for the status line. */
  activeTool: string | null;
  /** Show tool output and reasoning inline. */
  verbose: boolean;
}

export interface ApplyResult {
  state: TranscriptState;
  ops: RenderOp[];
}

const TOOL_OUTPUT_LINES = 8;

export function createTranscriptState(verbose = false): TranscriptState {
  return {
    written: {},
    tools: [],
    roles: {},
    suppressed: {},
    currentMessageID: null,
    streamingText: false,
    working: false,
    activeTool: null,
    verbose,
  };
}

/** Mark a message id as already on screen — the TUI echoes what you typed the
 *  moment you press Enter, so the server's copy of it must not print twice. */
export function suppressMessage(state: TranscriptState, messageID: string): TranscriptState {
  return { ...state, suppressed: { ...state.suppressed, [messageID]: true } };
}

/** Turn on the working flag at submit time so the spinner appears before the
 *  first server event rather than after it. */
export function markWorking(state: TranscriptState): TranscriptState {
  return { ...state, working: true, streamingText: false };
}

function partKey(part: ChatPart | OpencodePart, fallbackIndex = 0): string {
  const p = part as ChatPart;
  if (p.id) return p.id;
  return `${p.messageID ?? 'msg'}:${p.callID ?? `${p.type}:${fallbackIndex}`}`;
}

function isTextLike(type: string): boolean {
  return type === 'text' || type === 'reasoning';
}

/** First line of a tool's input, in the shape a human recognizes. */
export function toolDetail(state: ChatPartState | undefined): string {
  const input = state?.input;
  if (state?.title) return firstLine(state.title);
  if (!input) return '';
  if (typeof input === 'string') return firstLine(input);
  if (typeof input === 'object') {
    const bag = input as Record<string, unknown>;
    for (const field of ['command', 'filePath', 'path', 'pattern', 'query', 'description']) {
      const value = bag[field];
      if (typeof value === 'string' && value.trim()) return firstLine(value);
    }
    try {
      return firstLine(JSON.stringify(bag));
    } catch {
      return '';
    }
  }
  return '';
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length <= 72 ? line : `${line.slice(0, 71)}…`;
}

function duration(entry: ToolEntry): string {
  if (!entry.startedAt || !entry.endedAt) return '';
  const ms = entry.endedAt - entry.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A tool still in flight — one line in the mutable tail. */
export function liveToolLine(entry: ToolEntry): string {
  const detail = entry.detail ? `  ${C.dim}${entry.detail}${C.reset}` : '';
  return `  ${C.faded}⋯ ${entry.name}${C.reset}${detail}`;
}

/** A settled tool — committed to scrollback, output collapsed unless it failed
 *  or the user asked for verbose (F3). */
export function settledToolLines(entry: ToolEntry, verbose: boolean): string[] {
  const failed = entry.status === 'error';
  const mark = failed ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
  const trailer = failed
    ? `  ${C.red}${firstLine(entry.error ?? 'failed')}${C.reset}`
    : `  ${C.faded}${duration(entry) || entry.detail}${C.reset}`;
  const lines = [`  ${mark} ${entry.name}${trailer}`];
  const output = entry.output?.trimEnd();
  if (output && (failed || verbose)) {
    for (const line of output.split('\n').slice(0, TOOL_OUTPUT_LINES)) {
      lines.push(`    ${C.dim}${line}${C.reset}`);
    }
  }
  return lines;
}

function roleHeader(role: string, at?: number): string[] {
  const color = role === 'assistant' ? C.cyan : C.green;
  const label = role === 'assistant' ? 'assistant' : 'you';
  const ts = at ? ` ${C.faded}${new Date(at).toLocaleTimeString()}${C.reset}` : '';
  return ['', `${color}${C.bold}${label}${C.reset}${ts}`];
}

function tailOp(state: TranscriptState): RenderOp {
  return { kind: 'tail', lines: state.tools.map(liveToolLine) };
}

/**
 * The "what is it doing" line, reusing the vocabulary of `deriveActivity` in
 * sessions-chat.ts so `kortix sessions status` and the TUI describe the same
 * agent the same way. Null means "nothing to say" — no spinner, no line.
 */
export function statusText(state: TranscriptState): string | null {
  if (state.activeTool) return `running ${state.activeTool}…`;
  if (state.working && !state.streamingText) return 'thinking…';
  return null;
}

/** Apply one event. Returns a NEW state plus the ops to render, in order. */
export function applyEvent(state: TranscriptState, event: ChatEvent): ApplyResult {
  switch (event.type) {
    case 'message.updated': {
      const id = event.message.id;
      if (!id) return { state, ops: [] };
      const role = event.message.role ?? 'assistant';
      const next = { ...state, roles: { ...state.roles, [id]: role } };
      const err = event.message.error;
      if (err) {
        return {
          state: { ...next, working: false, streamingText: false, activeTool: null },
          ops: [
            { kind: 'commit', lines: [`  ${C.red}error: ${err.message ?? 'unknown'}${C.reset}`] },
            tailOp(next),
          ],
        };
      }
      return { state: next, ops: [] };
    }

    case 'message.part.updated':
      return applyPart(state, event.part);

    case 'message.part.removed': {
      const written = { ...state.written };
      delete written[event.partID];
      return { state: { ...state, written }, ops: [] };
    }

    case 'session.idle': {
      // Anything still pending at idle will never settle — commit it so a stale
      // line cannot live in the tail forever.
      const stragglers = state.tools.flatMap((t) => settledToolLines(t, state.verbose));
      const next: TranscriptState = {
        ...state,
        tools: [],
        working: false,
        streamingText: false,
        activeTool: null,
      };
      const ops: RenderOp[] = [];
      if (stragglers.length > 0) ops.push({ kind: 'commit', lines: stragglers });
      ops.push(tailOp(next));
      return { state: next, ops };
    }

    case 'session.error': {
      const message =
        typeof event.error === 'string'
          ? event.error
          : ((event.error as { message?: string } | undefined)?.message ?? 'session error');
      const next: TranscriptState = {
        ...state,
        working: false,
        streamingText: false,
        activeTool: null,
        tools: [],
      };
      return {
        state: next,
        ops: [{ kind: 'commit', lines: [`  ${C.red}${message}${C.reset}`] }, tailOp(next)],
      };
    }

    default:
      return { state, ops: [] };
  }
}

function applyPart(state: TranscriptState, part: ChatPart): ApplyResult {
  const messageID = part.messageID ?? '';
  if (state.suppressed[messageID]) return { state, ops: [] };
  // A part whose message we have not seen a role for is an assistant part:
  // user parts only ever arrive attached to a message we already know about
  // (we submitted it) or replayed through `reconcile`.
  const role = state.roles[messageID] ?? 'assistant';
  if (role === 'user') return { state, ops: [] };

  const ops: RenderOp[] = [];
  let next = state;

  const openMessage = (): void => {
    if (next.currentMessageID === messageID) return;
    ops.push({ kind: 'commit', lines: roleHeader(role) });
    next = { ...next, currentMessageID: messageID };
  };

  if (isTextLike(part.type)) {
    // Reasoning is noise at default verbosity — the status line already says
    // "thinking…", so only --verbose streams the actual tokens.
    if (part.type === 'reasoning' && !state.verbose) {
      return { state: { ...state, working: true }, ops: [] };
    }
    if (part.synthetic) return { state, ops: [] };
    const key = partKey(part);
    const incoming = part.text ?? '';
    const prev = next.written[key] ?? '';
    // THE guard. A non-prefix frame is stale or out of order; printing it would
    // duplicate text and rewinding is impossible in scrollback.
    if (prev.length > 0 && !incoming.startsWith(prev)) return { state, ops: [] };
    const suffix = incoming.slice(prev.length);
    if (suffix.length === 0) return { state, ops: [] };
    openMessage();
    next = {
      ...next,
      written: { ...next.written, [key]: incoming },
      streamingText: true,
      working: true,
      activeTool: null,
    };
    const styled = part.type === 'reasoning' ? `${C.dim}${suffix}${C.reset}` : suffix;
    ops.push({ kind: 'append', text: styled });
    ops.push(tailOp(next));
    return { state: next, ops };
  }

  if (part.type === 'tool') {
    const key = partKey(part);
    const status = part.state?.status ?? 'pending';
    const entry: ToolEntry = {
      key,
      name: part.tool ?? 'tool',
      status,
      detail: toolDetail(part.state),
      startedAt: part.state?.time?.start,
      endedAt: part.state?.time?.end,
      output: part.state?.output,
      error: part.state?.error,
    };
    const settled = status === 'completed' || status === 'error';
    const others = next.tools.filter((t) => t.key !== key);
    if (settled) {
      openMessage();
      next = {
        ...next,
        tools: others,
        activeTool: others.length > 0 ? (others[others.length - 1]?.name ?? null) : null,
        streamingText: false,
      };
      ops.push({ kind: 'commit', lines: settledToolLines(entry, next.verbose) });
      ops.push(tailOp(next));
      return { state: next, ops };
    }
    openMessage();
    next = {
      ...next,
      tools: [...others, entry],
      activeTool: entry.name,
      working: true,
      streamingText: false,
    };
    ops.push(tailOp(next));
    return { state: next, ops };
  }

  if (part.type === 'file') {
    openMessage();
    const name = part.filename ? ` · ${part.filename}` : '';
    ops.push({ kind: 'commit', lines: [`  ${C.faded}[file${name}]${C.reset}`] });
    return { state: next, ops };
  }

  return { state, ops: [] };
}

/**
 * Reconcile against a `listMessages` snapshot — used for the initial history
 * replay and, critically, after a stream gap (F9/R3). Emits ONLY the suffix
 * past what is already committed, so a reconnect can never duplicate text nor
 * silently swallow the middle of a turn.
 */
export function reconcile(
  state: TranscriptState,
  messages: OpencodeMessageWithParts[],
): ApplyResult {
  let next = state;
  const ops: RenderOp[] = [];

  for (const message of messages) {
    const info = message.info as { id?: string; role?: string; time?: { created?: number } };
    const messageID = info.id ?? '';
    const role = info.role ?? 'assistant';
    if (messageID) next = { ...next, roles: { ...next.roles, [messageID]: role } };
    if (messageID && next.suppressed[messageID]) continue;

    let headerWritten = next.currentMessageID === messageID;
    const openMessage = (): void => {
      if (headerWritten) return;
      ops.push({ kind: 'commit', lines: roleHeader(role, info.time?.created) });
      next = { ...next, currentMessageID: messageID };
      headerWritten = true;
    };

    message.parts.forEach((rawPart, index) => {
      const part = { ...(rawPart as ChatPart), messageID: (rawPart as ChatPart).messageID ?? messageID };
      if (isTextLike(part.type)) {
        if (part.synthetic) return;
        if (part.type === 'reasoning' && !next.verbose) return;
        const key = partKey(part, index);
        const incoming = part.text ?? '';
        const prev = next.written[key] ?? '';
        if (prev.length > 0 && !incoming.startsWith(prev)) return;
        const suffix = incoming.slice(prev.length);
        if (!suffix) return;
        openMessage();
        next = { ...next, written: { ...next.written, [key]: incoming } };
        ops.push({
          kind: 'append',
          text: part.type === 'reasoning' ? `${C.dim}${suffix}${C.reset}` : suffix,
        });
        return;
      }
      if (part.type === 'tool') {
        const key = partKey(part, index);
        const status = part.state?.status ?? 'pending';
        const entry: ToolEntry = {
          key,
          name: part.tool ?? 'tool',
          status,
          detail: toolDetail(part.state),
          startedAt: part.state?.time?.start,
          endedAt: part.state?.time?.end,
          output: part.state?.output,
          error: part.state?.error,
        };
        const settled = status === 'completed' || status === 'error';
        // A settled tool is committed once and remembered by its key, so a
        // second reconcile over the same window does not reprint it.
        if (settled) {
          if (next.written[key] !== undefined) return;
          openMessage();
          next = { ...next, written: { ...next.written, [key]: status } };
          ops.push({ kind: 'commit', lines: settledToolLines(entry, next.verbose) });
          return;
        }
        openMessage();
        next = {
          ...next,
          tools: [...next.tools.filter((t) => t.key !== key), entry],
          activeTool: entry.name,
        };
      }
    });
  }

  ops.push(tailOp(next));
  return { state: next, ops };
}
