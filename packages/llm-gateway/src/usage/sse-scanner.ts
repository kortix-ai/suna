import type { SseErrorFrame } from './completion-guard';
import { type ExtractedUsage, type UpstreamChunkShape, normalizeUsageChunk } from './extract';

// A well-formed SSE `data:` line for a chat-completion chunk (usage frame,
// error frame, or content delta) is at most a few KB. An upstream that never
// terminates a line with `\n` is malformed — carrying an unbounded amount of
// text forever waiting for a newline that never comes would defeat the whole
// point of bounding this scanner's memory, so the carry is capped and the
// oldest bytes are dropped once it's exceeded.
const DEFAULT_MAX_CARRY_BYTES = 1024 * 1024;

/**
 * Incrementally scans an SSE token stream for the two things `settle()` needs
 * at the end of a completion — the final usage frame and the first upstream
 * error frame — WITHOUT retaining the full stream text for the life of the
 * request. Memory is bounded by `maxCarryBytes` (the worst case: a single
 * unterminated "line") rather than growing with total tokens streamed.
 *
 * This mirrors exactly what `extractUsageFromSseBuffer`/`sseErrorFrame` did
 * over a fully-accumulated buffer: last usage frame wins, first error frame
 * wins, and only `data:` lines are considered.
 */
export class IncrementalSseScanner {
  private carry = '';
  private lastUsage: ExtractedUsage | null = null;
  private lastModel: string | undefined;
  private errorFrame: SseErrorFrame | null = null;
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
    if (!payload || payload === '[DONE]') return;
    let chunk: UpstreamChunkShape & { error?: unknown };
    try {
      chunk = JSON.parse(payload) as UpstreamChunkShape & { error?: unknown };
    } catch {
      return;
    }
    if (chunk?.model) this.lastModel = chunk.model;
    if (chunk?.usage) this.lastUsage = normalizeUsageChunk(chunk);
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

  /** First upstream error frame seen, or null on a clean stream. */
  get error(): SseErrorFrame | null {
    return this.errorFrame;
  }
}
