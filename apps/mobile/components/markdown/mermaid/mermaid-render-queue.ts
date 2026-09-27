/**
 * The request side of the Mermaid renderer, free of React and native code.
 *
 * One hidden WebView (`MermaidRendererHost`) runs Mermaid. Every diagram block
 * asks this queue for its SVG. The queue:
 * - answers from a content-hash cache first (web's `mermaidCache`), so a block
 *   that scrolls back into view never renders twice;
 * - merges concurrent requests for the same chart into one render;
 * - holds requests until the WebView reports ready, and re-sends them after
 *   the WebView process dies and the host remounts it;
 * - fails a request after `MERMAID_RENDER_TIMEOUT_MS`.
 *
 * Mermaid errors are cached like results: the same source fails the same way.
 * Timeouts and renderer crashes are not cached, so a later mount retries.
 */
import {
  hasRenderableMermaidStarter,
  mermaidChartHash,
  mermaidErrorMessage,
  MERMAID_RENDER_TIMEOUT_MS,
  parseMermaidViewBox,
  rendererRenderScript,
  type MermaidViewBox,
} from './mermaid-html';

export interface MermaidDiagram {
  svg: string;
  viewBox: MermaidViewBox;
}

export type MermaidOutcome = { ok: true; diagram: MermaidDiagram } | { ok: false; error: string };

interface Pending {
  id: number;
  chart: string;
  hash: string;
  sent: boolean;
  promise: Promise<MermaidOutcome>;
  settle: (outcome: MermaidOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MermaidRenderQueue {
  private readonly results = new Map<string, MermaidOutcome>();
  private readonly pending = new Map<string, Pending>();
  private readonly byId = new Map<number, Pending>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private inject: ((script: string) => void) | null = null;
  private wanted = false;

  constructor(private readonly timeoutMs = MERMAID_RENDER_TIMEOUT_MS) {}

  /** A finished render for `chart`, or null. Synchronous, for the first paint. */
  peek(chart: string): MermaidOutcome | null {
    return this.results.get(mermaidChartHash(chart)) ?? null;
  }

  render(chart: string): Promise<MermaidOutcome> {
    const hash = mermaidChartHash(chart);
    const known = this.results.get(hash);
    if (known) return Promise.resolve(known);
    if (!hasRenderableMermaidStarter(chart)) {
      const outcome: MermaidOutcome = { ok: false, error: 'Invalid diagram type' };
      this.results.set(hash, outcome);
      return Promise.resolve(outcome);
    }
    const inFlight = this.pending.get(hash);
    if (inFlight) return inFlight.promise;

    let settle!: (outcome: MermaidOutcome) => void;
    const promise = new Promise<MermaidOutcome>((resolve) => {
      settle = resolve;
    });
    const request: Pending = {
      id: this.nextId++,
      chart,
      hash,
      sent: false,
      promise,
      settle,
      timer: setTimeout(() => this.finish(request, { ok: false, error: 'timeout' }, false), this.timeoutMs),
    };
    this.pending.set(hash, request);
    this.byId.set(request.id, request);
    this.send(request);
    if (!this.wanted) {
      this.wanted = true;
      this.notify();
    }
    return promise;
  }

  /** The host mounts its WebView once any block has asked for a diagram. */
  isWanted(): boolean {
    return this.wanted;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The renderer page answered `ready`: send everything that waits. */
  attach(inject: (script: string) => void): void {
    this.inject = inject;
    for (const request of this.pending.values()) this.send(request);
  }

  /** The WebView is gone (process crash, remount): re-send on the next attach. */
  detach(): void {
    this.inject = null;
    for (const request of this.pending.values()) request.sent = false;
  }

  /** The renderer cannot start (asset missing, Mermaid failed to initialize). */
  failAll(error: string): void {
    this.detach();
    for (const request of [...this.pending.values()]) this.finish(request, { ok: false, error }, false);
    this.wanted = false;
    this.notify();
  }

  /** Handles a message the renderer page posted and says what it was. */
  handleMessage(data: string): 'ready' | 'fatal' | 'result' | 'ignored' {
    let message: { ready?: boolean; fatal?: string; id?: number; svg?: string; error?: string };
    try {
      message = JSON.parse(data);
    } catch {
      return 'ignored';
    }
    if (message.ready) return 'ready';
    if (typeof message.fatal === 'string') {
      this.failAll(message.fatal);
      return 'fatal';
    }
    const request = typeof message.id === 'number' ? this.byId.get(message.id) : undefined;
    if (!request) return 'ignored';
    if (typeof message.svg === 'string') {
      const viewBox = parseMermaidViewBox(message.svg);
      this.finish(
        request,
        viewBox ? { ok: true, diagram: { svg: message.svg, viewBox } } : { ok: false, error: 'Diagram has no size' },
        true,
      );
    } else {
      this.finish(request, { ok: false, error: mermaidErrorMessage(String(message.error)) }, true);
    }
    return 'result';
  }

  private send(request: Pending): void {
    if (!this.inject || request.sent) return;
    request.sent = true;
    this.inject(rendererRenderScript(request.id, request.chart));
  }

  private finish(request: Pending, outcome: MermaidOutcome, cache: boolean): void {
    if (this.pending.get(request.hash) !== request) return;
    clearTimeout(request.timer);
    this.pending.delete(request.hash);
    this.byId.delete(request.id);
    if (cache) this.results.set(request.hash, outcome);
    request.settle(outcome);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The app's one queue, shared by every diagram block and the renderer host. */
export const mermaidRenderQueue = new MermaidRenderQueue();
