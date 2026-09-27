import { chunkOutputChars } from './estimate';
import { type ExtractedUsage, type UpstreamChunkShape, normalizeUsageChunk } from './extract';

// A well-formed SSE `data:` line for a chat-completion chunk (usage frame,
// error frame, or content delta) is at most a few KB. An upstream that never
// terminates a line with `\n` is malformed — carrying an unbounded amount of
// text forever waiting for a newline that never comes would defeat the whole
// point of bounding this scanner's memory, so the carry is capped and the
// oldest bytes are dropped once it's exceeded.
const DEFAULT_MAX_CARRY_BYTES = 1024 * 1024;

/** The first in-band `error` object an upstream streamed. */
export interface SseErrorFrame {
  message: string;
  code?: string | number;
  /**
   * Every REMAINING field of the upstream's `error` object, verbatim, minus
   * `message`/`code` above. Upstreams put the actually-actionable part of a
   * rejection here — OpenAI-shaped backends use `type`/`param` to name the
   * offending field — and dropping it collapses a specific, fixable error into
   * an unactionable one. That cost real debugging time: every Codex request
   * 400'd with nothing in the logs but `"Bad Request"`, and finding the true
   * cause (a missing `store: false`) needed git archaeology against a deleted
   * transport rather than just reading the error. Kept as an opaque bag so any
   * upstream's extra fields survive without this type having to know them.
   */
  detail?: Record<string, unknown>;
}

/**
 * Incrementally scans an SSE token stream for the two things `settle()` needs
 * at the end of a completion — the final usage frame and the first upstream
 * error frame — WITHOUT retaining the full stream text for the life of the
 * request. Memory is bounded by `maxCarryBytes` (the worst case: a single
 * unterminated "line") rather than growing with total tokens streamed.
 *
 * Last usage frame wins, first error frame wins, and only `data:` lines are
 * considered.
 */
export class IncrementalSseScanner {
  private carry = '';
  private lastUsage: ExtractedUsage | null = null;
  private lastModel: string | undefined;
  private errorFrame: SseErrorFrame | null = null;
  private streamedOutputChars = 0;
  // Set once a `data: [DONE]` sentinel or a non-null `choices[].finish_reason`
  // is seen on a complete line. Distinct from `errorFrame`: an upstream that
  // sends an in-band error and then just drops the connection never said
  // `[DONE]` — `relayStream` uses `isTerminal` (below) to tell "the upstream
  // reached a well-defined end" from "the upstream just stopped sending
  // bytes", which #7679's boundary-repair alone does not distinguish.
  private explicitDone = false;
  private readonly maxCarryBytes: number;

  constructor(maxCarryBytes: number = DEFAULT_MAX_CARRY_BYTES) {
    this.maxCarryBytes = maxCarryBytes;
  }

  /** Feed the next decoded text chunk. Call `finish()` once the stream ends. */
  push(text: string): void {
    if (!text) return;
    this.carry += text;
    let nl = this.carry.indexOf('\n');
    while (nl >= 0) {
      this.consumeLine(this.carry.slice(0, nl));
      this.carry = this.carry.slice(nl + 1);
      nl = this.carry.indexOf('\n');
    }
    if (this.carry.length > this.maxCarryBytes) {
      this.carry = this.carry.slice(this.carry.length - this.maxCarryBytes);
    }
  }

  /** Flush a final unterminated line (upstream closed without a trailing `\n`). */
  finish(): void {
    if (this.carry) {
      this.consumeLine(this.carry);
      this.carry = '';
    }
  }

  private consumeLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      this.explicitDone = true;
      return;
    }
    let chunk: UpstreamChunkShape & {
      error?: unknown;
      choices?: Array<{ finish_reason?: unknown } | null | undefined>;
    };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
    if (chunk?.model) this.lastModel = chunk.model;
    if (chunk?.usage) this.lastUsage = normalizeUsageChunk(chunk);
    this.streamedOutputChars += chunkOutputChars(chunk);
    if (Array.isArray(chunk?.choices)) {
      for (const choice of chunk.choices) {
        const finishReason = choice?.finish_reason;
        if (typeof finishReason === 'string' && finishReason.length > 0) {
          this.explicitDone = true;
          break;
        }
      }
    }
    if (!this.errorFrame && chunk?.error && typeof chunk.error === 'object') {
      const { message, code, ...rest } = chunk.error as {
        message?: unknown;
        code?: unknown;
        [k: string]: unknown;
      };
      if (typeof message === 'string' && message.length > 0) {
        this.errorFrame = {
          message,
          ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
          // Retain whatever else the upstream named (`type`, `param`, …) — see
          // SseErrorFrame.detail. Only when non-empty, so a plain
          // `{message, code}` frame keeps producing exactly the old object.
          ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
        };
      }
    }
  }

  /** Final usage frame seen (last one wins), or null if none carried usage. */
  get usage(): ExtractedUsage | null {
    if (this.lastUsage && !this.lastUsage.model && this.lastModel) {
      this.lastUsage.model = this.lastModel;
    }
    return this.lastUsage;
  }

  /**
   * Characters of generated output (content, reasoning, tool-call arguments)
   * seen so far. The usage estimate for a stream that ends without a usage
   * frame is built from it.
   */
  get outputChars(): number {
    return this.streamedOutputChars;
  }

  /** First upstream error frame seen, or null on a clean stream. */
  get error(): SseErrorFrame | null {
    return this.errorFrame;
  }

  /** True once `[DONE]` or a populated `finish_reason` was seen. */
  get hasExplicitDone(): boolean {
    return this.explicitDone;
  }

  /**
   * Did the upstream reach a well-defined end of its own accord — `[DONE]`,
   * a populated `finish_reason`, or an in-band `error` frame? False means the
   * caller learned NOTHING about why generation stopped: the silent-
   * truncation case `relayStream`'s incomplete-stream handling exists to
   * catch.
   */
  get isTerminal(): boolean {
    return this.explicitDone || this.errorFrame !== null;
  }
}
