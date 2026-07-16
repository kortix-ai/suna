/**
 * Generic, compile-time-exhaustive part -> T dispatcher.
 *
 * No React import — `T` is typically `ReactNode`, but this file stays
 * framework-free (same reasoning as `classifyPart` itself) so a host isn't
 * forced through React to use it. It lives under `react/chat/` because that's
 * where the rest of the chat-rendering surface is, not because it needs React.
 *
 * `PartRenderers<T>` requires a renderer for every `ClassifiedPart['kind']`
 * (an optional `fallback` covers `'unknown'`-only handling, or lets a host
 * opt out of exhaustiveness during a migration) — TypeScript itself enforces
 * that a host's switch-equivalent covers every part kind, closing the
 * "silently drops subtask/patch/snapshot/agent/retry/compaction" bug class at
 * the CALL site the same way `classifyPart` closes it at the classification
 * site.
 *
 * @deprecated Part of the OpenCode-wire projection stack — dispatches over
 * `ClassifiedPart` (`../../core/turns/classify.ts`), superseded by the ACP
 * `AcpChatItem` union. `apps/whitelabel-demo`'s `tool-call.tsx`/
 * `message-view.tsx` are the one real consumer today; kept working, not
 * removed.
 */

import type { ClassifiedPart } from '../../core/turns';

type PartOfKind<K extends ClassifiedPart['kind']> = Extract<ClassifiedPart, { kind: K }>;

/** @deprecated See the module doc above. */
export type PartRenderers<T> = {
  [K in ClassifiedPart['kind']]: (part: PartOfKind<K>) => T;
} & {
  /** Escape hatch: if provided, used instead of throwing for any kind whose
   *  dedicated renderer is missing (only reachable if a caller constructs a
   *  `PartRenderers<T>` with `Partial<...>` and casts — the type normally
   *  requires every kind). */
  fallback?: (part: ClassifiedPart) => T;
};

/**
 * Render every classified part with its matching renderer, in order.
 * Throws if a part's kind has no renderer AND no `fallback` was given —
 * this should be unreachable given `PartRenderers<T>`'s type (every kind is
 * required), so hitting it means the renderers object was built unsafely
 * (e.g. via `as PartRenderers<T>`).
 *
 * @deprecated Part of the OpenCode-wire projection stack — see the module
 * doc above.
 */
export function renderParts<T>(parts: ClassifiedPart[], renderers: PartRenderers<T>): T[] {
  return parts.map((part) => {
    const renderer = renderers[part.kind] as ((p: ClassifiedPart) => T) | undefined;
    if (renderer) return renderer(part);
    if (renderers.fallback) return renderers.fallback(part);
    throw new Error(`renderParts: no renderer registered for part kind "${part.kind}"`);
  });
}
