import type { ArtifactCommentAnchor, ArtifactCommentThread } from '@kortix/sdk';
import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  parseArtifactAnnotationHostMessage,
  type ArtifactAnnotationFrameMessage,
  type ArtifactAnnotationHostMessage,
  type ArtifactAnnotationLayout,
  type ArtifactAnnotationRect,
  type ArtifactAnnotationViewport,
} from '@kortix/shared/artifact-annotations';
import { artifactCommentAnchorSchema, createArtifactReanchorBudgets } from '@kortix/shared/artifact-comments';
import { createArtifactAnnotationCapture } from './artifact-annotation-capture';
import {
  assembleArtifactAnnotationLayout,
  resolveArtifactAnnotationAnchor,
  type ArtifactAnnotationInventory,
} from './artifact-annotation-layout';
import { threadAuthor, threadDeleted } from './artifact-discussion-logic';

type Config = {
  version: string;
  canComment: boolean;
  mode: 'text' | 'comment';
  threads: readonly ArtifactCommentThread[];
  focusedThreadId: string | null;
  focusRevision: number;
  /** The accessible name of pin `n` ("Comment 3"). It must name the number; anything else is dropped. */
  pinLabel?: (n: number) => string;
  /** The parent's drawing layer covers the page and handles its own Escape: page keys are dropped. */
  drawing?: boolean;
};
const envelope = { kortix: 'annotate', v: 1 } as const;
export type ArtifactAnnotationStatus = 'loading' | 'ready' | 'unavailable';
/** A text selection the page offers: its box in frame viewport coordinates, when the page measured one. */
export type ArtifactAnnotationSelection =
  | { state: 'candidate'; anchor: ArtifactCommentAnchor; rect: ArtifactAnnotationRect | null }
  | { state: 'too_long'; rect: ArtifactAnnotationRect | null };
export type ArtifactAnnotationKey = 'escape' | 'comment';

function pinLabel(config: Config, n: number): string | undefined {
  const label = config.pinLabel?.(n);
  return label &&
    label.length <= limits.pinLabel &&
    label.includes(String(n)) &&
    !/[\u0000\uD800-\uDFFF]/u.test(label)
    ? label
    : undefined;
}
export type ArtifactAnnotationScheduler = (callback: () => void, delay: number) => () => void;
const scheduleDeadline: ArtifactAnnotationScheduler = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

export function createArtifactAnnotationController(
  callbacks: {
    post: (message: ArtifactAnnotationHostMessage) => boolean;
    /** A pin or region placed in comment mode: the person asked to comment there. */
    onCandidate: (anchor: ArtifactCommentAnchor) => void;
    /**
     * The page's text selection changed: an offer to comment on it, or null when it is gone.
     * `moved`: a scroll or resize in the page withdrew the offer, not the person.
     */
    onSelection?: (selection: ArtifactAnnotationSelection | null, moved?: boolean) => void;
    /**
     * Escape or the comment shortcut, from the page. The page can post either at any time: a key
     * arrives only where the bridge sends one, and never while the parent draws.
     */
    onKey?: (key: ArtifactAnnotationKey) => void;
    onFocus: (threadId: string) => void;
    onThreads: (threads: ArtifactCommentThread[]) => void;
    onStatus?: (status: ArtifactAnnotationStatus) => void;
    onViewport?: (viewport: ArtifactAnnotationViewport | null) => void;
    onRegions?: (regions: Readonly<Record<string, ArtifactAnnotationRect>>) => void;
    /** thread_id → the number of its pin on the page, for every pin the page draws. */
    onPins?: (pins: ReadonlyMap<string, number>) => void;
  },
  schedule: ArtifactAnnotationScheduler = scheduleDeadline,
) {
  const capture = createArtifactAnnotationCapture(callbacks.post, schedule);
  let config: Config | null = null;
  let inventory: ArtifactAnnotationInventory | null = null;
  let chunks: ArtifactAnnotationLayout[] = [];
  let units = 0;
  let items = 0;
  let latestRevision = -1;
  let sent = new Map<number, string>();
  const ordinals = new Map<string, number>();
  let focused = '';
  // A selection offer is current. In text mode the bridge sends its keys only then.
  let offered = false;
  const select = (selection: ArtifactAnnotationSelection | null, moved?: boolean) => {
    offered = !!selection;
    callbacks.onSelection?.(selection, moved);
  };
  let status: ArtifactAnnotationStatus | null = null;
  let cancelDeadline: (() => void) | null = null;
  let generation = 0;
  let disposed = false;
  const postMode = () => {
    if (config && !disposed)
      callbacks.post({
        ...envelope,
        type: 'mode',
        mode: config.canComment && status === 'ready' ? config.mode : 'off',
      });
  };
  const clearDeadline = () => {
    generation++;
    cancelDeadline?.();
    cancelDeadline = null;
  };
  const readiness = (next: ArtifactAnnotationStatus) => {
    if (next !== 'loading') clearDeadline();
    if (status !== next) {
      status = next;
      callbacks.onStatus?.(next);
      postMode();
    }
  };
  const loading = (restart = false) => {
    if (!restart && status === 'loading' && cancelDeadline) return;
    clearDeadline();
    capture.cancel('stale');
    callbacks.onViewport?.(null);
    readiness('loading');
    const attempt = generation;
    cancelDeadline = schedule(() => {
      if (!disposed && generation === attempt) readiness('unavailable');
    }, 15000);
  };
  const handshake = () => {
    if (!config) return;
    postMode();
    callbacks.post({ ...envelope, type: 'request_layout' });
  };
  const redraw = () => {
    if (!config) return;
    const current = config;
    const pins: Extract<ArtifactAnnotationHostMessage, { type: 'draw' }>['pins'] = [];
    const ids = new Map<number, string>();
    const regions: Record<string, ArtifactAnnotationRect> = {};
    // A thread keeps its number while it is listed. A thread that leaves the list (an optimistic
    // thread replaced by the saved one, a deleted thread) frees its number: the next new thread
    // takes the smallest free one, so the page and the sidebar count from 1 without gaps.
    const listed = new Set(current.threads.map((thread) => thread.thread_id));
    for (const id of [...ordinals.keys()]) if (!listed.has(id)) ordinals.delete(id);
    const used = new Set(ordinals.values());
    let cursor = 1;
    const freeOrdinal = () => {
      while (used.has(cursor)) cursor++;
      used.add(cursor);
      return cursor;
    };
    // One re-anchoring budget per layout pass, split per thread author: crafted quotes cannot freeze the
    // tab or leave other people's pins out.
    const budgetFor = createArtifactReanchorBudgets(current.threads.map(threadAuthor));
    const rows = current.threads.map((thread) => {
      if (thread.anchor.type === 'none') return thread;
      const resolved = inventory
        ? resolveArtifactAnnotationAnchor(thread.anchor, inventory, current.version, budgetFor(threadAuthor(thread)))
        : null;
      if (
        resolved?.status === 'resolved' &&
        thread.anchor.type === 'region' &&
        !threadDeleted(thread) &&
        resolved.rects[0]
      )
        regions[thread.thread_id] = { ...resolved.rects[0] };
      if (
        resolved?.status === 'resolved' &&
        !threadDeleted(thread) &&
        (thread.status === 'open' || thread.thread_id === current.focusedThreadId) &&
        pins.length < limits.pins
      ) {
        let n = ordinals.get(thread.thread_id);
        if (n === undefined && ordinals.size < limits.elements) {
          n = freeOrdinal();
          ordinals.set(thread.thread_id, n);
        }
        if (n === undefined) return { ...thread, outdated: false, position: resolved.position };
        const label = pinLabel(current, n);
        pins.push({
          n,
          rects: resolved.rects,
          ranges: resolved.ranges,
          ...(label ? { label } : {}),
        });
        ids.set(n, thread.thread_id);
      }
      return {
        ...thread,
        outdated: resolved?.outdated === true,
        position: resolved?.position ?? null,
      };
    });
    callbacks.onThreads(rows);
    callbacks.onRegions?.(regions);
    if (!inventory) {
      callbacks.onPins?.(new Map());
      return;
    }
    const active = [...ids].find(([, id]) => id === current.focusedThreadId)?.[0] ?? null;
    if (active !== null) pins.sort((a, b) => Number(b.n === active) - Number(a.n === active));
    const signature = `${current.focusedThreadId}:${current.focusRevision}`;
    const message = {
      ...envelope,
      type: 'draw' as const,
      revision: inventory.revision,
      pins,
      active,
      focus: active !== null && signature !== focused,
    };
    while (!parseArtifactAnnotationHostMessage(message) && pins.length) {
      const removed = pins.pop()!;
      ids.delete(removed.n);
    }
    if (message.active !== null && !ids.has(message.active)) message.active = null;
    message.focus = message.focus && message.active !== null;
    if (callbacks.post(message)) {
      sent = ids;
      if (message.focus) focused = signature;
      callbacks.onPins?.(new Map([...ids].map(([n, id]) => [id, n])));
    }
  };
  const selectionGeometry = (
    rect: ArtifactAnnotationRect | undefined,
    viewport: ArtifactAnnotationViewport,
  ): ArtifactAnnotationRect | null =>
    rect ? { ...rect, x: rect.x - viewport.scroll.x, y: rect.y - viewport.scroll.y } : null;
  const offersSelection = () =>
    !!config?.canComment && config.mode === 'text' && status === 'ready' && !!inventory?.complete;
  return {
    isCurrentViewport(viewport: ArtifactAnnotationViewport) {
      return (
        config?.canComment === true &&
        status === 'ready' &&
        inventory?.complete === true &&
        inventory.viewport === viewport &&
        inventory.revision === latestRevision
      );
    },
    capture(rect: ArtifactAnnotationRect) {
      if (!config?.canComment || status !== 'ready' || !inventory?.complete)
        return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
      return capture.begin(rect, inventory.revision);
    },
    cancelCapture: capture.cancel,
    regionForViewportRect(rect: ArtifactAnnotationRect) {
      if (
        !config?.canComment ||
        status !== 'ready' ||
        !inventory?.complete ||
        !Object.values(rect).every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > inventory.viewport.width ||
        rect.y + rect.height > inventory.viewport.height
      )
        return null;
      const { viewport } = inventory;
      const documentRect = {
        ...rect,
        x: rect.x + viewport.scroll.x,
        y: rect.y + viewport.scroll.y,
      };
      const element = inventory.elements
        .filter(
          (item) =>
            item.rect.x <= documentRect.x &&
            item.rect.y <= documentRect.y &&
            item.rect.x + item.rect.width >= documentRect.x + rect.width &&
            item.rect.y + item.rect.height >= documentRect.y + rect.height,
        )
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
      if (!element) return null;
      const x = (documentRect.x - element.rect.x) / element.rect.width;
      const y = (documentRect.y - element.rect.y) / element.rect.height;
      const anchor: Extract<ArtifactCommentAnchor, { type: 'region' }> = {
        type: 'region',
        version: config.version,
        selector: element.selector,
        snippet: element.snippet,
        viewport_width: viewport.width,
        scroll: viewport.scroll,
        offset: {
          x,
          y,
          width: Math.min(1 - x, rect.width / element.rect.width),
          height: Math.min(1 - y, rect.height / element.rect.height),
        },
      };
      return artifactCommentAnchorSchema.safeParse(anchor).success
        ? { anchor, documentRect }
        : null;
    },
    update(next: Config) {
      if (disposed) return;
      const changedVersion = config?.version !== next.version;
      if (changedVersion) {
        inventory = null;
        chunks = [];
        units = 0;
        items = 0;
        latestRevision = -1;
        sent.clear();
        focused = '';
      }
      const modeChanged =
        !config || config.canComment !== next.canComment || config.mode !== next.mode;
      if (!next.canComment) capture.cancel();
      config = next;
      if (changedVersion) loading(true);
      if (modeChanged) postMode();
      if (changedVersion || modeChanged) select(null);
      redraw();
    },
    reset() {
      if (disposed) return;
      select(null);
      inventory = null;
      chunks = [];
      units = 0;
      items = 0;
      latestRevision = -1;
      sent.clear();
      focused = '';
      loading(true);
      redraw();
      handshake();
    },
    receive(message: ArtifactAnnotationFrameMessage) {
      if (disposed || !config) return;
      if (message.type.startsWith('capture_')) {
        capture.receive(message);
        return;
      }
      if (message.type === 'ready') {
        handshake();
        return;
      }
      if (message.type === 'layout') {
        if (message.revision < latestRevision) return;
        if (message.chunk === 0 && message.revision > latestRevision) {
          loading();
          latestRevision = message.revision;
          chunks = [];
          units = 0;
          items = 0;
        }
        if (
          message.revision !== latestRevision ||
          message.chunk !== chunks.length ||
          chunks.at(-1)?.final
        )
          return;
        units += message.texts.reduce((sum, text) => sum + text.text.length, 0);
        items += message.elements.length + message.texts.length;
        if (
          units > limits.textUnits ||
          items > limits.elements + limits.texts ||
          chunks.length >= limits.chunks
        ) {
          chunks = [];
          readiness('unavailable');
          return;
        }
        chunks.push(message);
        if (!message.final) return;
        const next = assembleArtifactAnnotationLayout(chunks);
        if (next) {
          inventory = next;
          readiness(next.complete ? 'ready' : 'unavailable');
          callbacks.onViewport?.(next.complete ? next.viewport : null);
          redraw();
        } else readiness('unavailable');
        return;
      }
      if (message.type === 'candidate') {
        if (
          !config.canComment ||
          !inventory?.complete ||
          message.revision !== inventory.revision ||
          message.revision !== latestRevision
        )
          return;
        const result = artifactCommentAnchorSchema.safeParse({
          ...message.anchor,
          version: config.version,
        });
        if (!result.success) return;
        // A text selection is only an offer: the parent shows a Comment chip and waits for the person.
        if (result.data.type === 'text' && callbacks.onSelection) {
          if (offersSelection())
            select({
              state: 'candidate',
              anchor: result.data,
              rect: selectionGeometry(message.rect, inventory.viewport),
            });
          return;
        }
        // The bridge places a pin or a region only in pin mode. One posted in text mode is forged:
        // it would open the composer, and take keyboard focus, with no action by the person.
        if (result.data.type !== 'text' && config.mode !== 'comment') return;
        callbacks.onCandidate(result.data);
        return;
      }
      if (message.type === 'selection') {
        if (message.state === 'none') select(null, message.moved === true);
        else if (!offersSelection()) select(null);
        else
          select({
            state: 'too_long',
            rect: selectionGeometry(message.rect, inventory!.viewport),
          });
        return;
      }
      if (message.type === 'key') {
        // Anything in the page can post a key, so a key counts only where the bridge sends one:
        // Escape in pin mode or with a selection offer, the shortcut with a selection offer. The
        // drawing layer covers the page and handles its own Escape, so no page key reaches it.
        if (!config.canComment || config.drawing) return;
        const sendable =
          message.key === 'escape'
            ? config.mode === 'comment' || offered
            : config.mode === 'text' && offered;
        if (sendable) callbacks.onKey?.(message.key);
        return;
      }
      if (message.type !== 'focus') return;
      const id = sent.get(message.n);
      if (id) callbacks.onFocus(id);
    },
    dispose() {
      capture.cancel();
      disposed = true;
      clearDeadline();
      config = null;
      inventory = null;
      sent.clear();
    },
  };
}
