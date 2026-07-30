'use client';

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

/** Intrinsic pixel dimensions of a document, as decoded/measured by a renderer. */
export interface IntrinsicSize {
  width: number;
  height: number;
}

export interface PreviewFit {
  /** Called by a renderer once it knows the document's real, unscaled size. */
  report: (size: IntrinsicSize) => void;
}

/**
 * True for a size a renderer can actually reason about. Filters at the
 * boundary so `report` (and, downstream, `fitSplitPercent`'s `aspect` input)
 * never receives `0`, a negative measurement, `NaN`, or `Infinity` — a
 * mid-decode or failed-load size a renderer might report in passing.
 * Exported so the guard is testable without mounting anything.
 */
export function isUsableIntrinsicSize(size: IntrinsicSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

const PreviewFitContext = createContext<PreviewFit | null>(null);

export function PreviewFitProvider({
  onMeasure,
  children,
}: {
  onMeasure: (size: IntrinsicSize) => void;
  children: ReactNode;
}) {
  // Keep the latest callback in a ref rather than the memo's dependency
  // array: a caller that passes an inline arrow (the common case) would
  // otherwise produce a new `report` — and thus a new context value — on
  // every render, re-rendering every consumer down the tree. `report` reads
  // through the ref, so the identity below only depends on the ref itself,
  // which never changes.
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const value = useMemo<PreviewFit>(
    () => ({
      report: (size) => {
        if (!isUsableIntrinsicSize(size)) return;
        onMeasureRef.current(size);
      },
    }),
    [],
  );

  return <PreviewFitContext.Provider value={value}>{children}</PreviewFitContext.Provider>;
}

/**
 * Returns `null` outside a provider, unlike `useFileSource`'s throw. A file
 * source missing is a wiring bug on every surface that mounts the renderer.
 * A fit context missing is the *normal* state everywhere except the Easy
 * panel — the Advanced-mode viewer, `/projects` previews, the file-preview
 * modal, and share pages have no ratio-fit split to feed, so they never
 * mount a <PreviewFitProvider>. Renderers call `report` unconditionally and
 * this returning `null` is how they no-op there without a surface check.
 */
export function usePreviewFit(): PreviewFit | null {
  return useContext(PreviewFitContext);
}
