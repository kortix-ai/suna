/**
 * What a sheet with modal steps shares: the provider sheet and the connector
 * sheet each run a `Flow` of steps (an input, a confirm, a sign-in) over their
 * `view`, and each step owns every key while it is open.
 *
 * - `useSheetFlow` holds the flow and tells the host whether a step is open
 *   (`onBusy`), and releases the keys and aborts a sign-in on unmount.
 * - `useSheetRun` runs one write: pending, refresh, toast, back to `VIEW`.
 * - `useMaskedPaste` appends a bracketed paste to a masked field.
 */

import { decodePasteBytes } from '@opentui/core';
import { usePaste } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorText } from '../lib/errors.ts';

export const VIEW = { kind: 'view' } as const;

/** A sheet's flow. `F` is the sheet's own union, `typeof VIEW` among its variants. */
export function useSheetFlow<F extends { kind: string }>(onBusy: (busy: boolean) => void) {
  const [flow, setFlowState] = useState<F | typeof VIEW>(VIEW);
  /** The sign-in in flight; Esc and unmount abort it. */
  const abort = useRef<AbortController | null>(null);

  const setFlow = useCallback(
    (next: F | typeof VIEW) => {
      setFlowState(next);
      onBusy(next.kind !== 'view');
    },
    [onBusy],
  );
  useEffect(
    () => () => {
      abort.current?.abort(new Error('cancelled'));
      onBusy(false);
    },
    [onBusy],
  );
  return { flow, setFlow, setFlowState, abort };
}

export type SheetFlow<F extends { kind: string }> = ReturnType<typeof useSheetFlow<F>>;

interface SheetRunOptions {
  setFlow(next: typeof VIEW): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Re-read what the write changed. `expect` names the provider a write connected. */
  refresh(expect?: string): Promise<unknown>;
  /** Also re-read after a failed write: it may have applied in part. */
  refreshOnError?: boolean;
}

/** The write wrapper. An error toasts and keeps the step open. */
export function useSheetRun({ setFlow, onToast, refresh, refreshOnError = false }: SheetRunOptions) {
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async (label: string, work: () => Promise<unknown>, done: string, expect?: string) => {
      setPending(label);
      try {
        await work();
        await refresh(expect);
        onToast(done);
        setFlow(VIEW);
      } catch (error) {
        if (refreshOnError) await refresh();
        onToast(errorText(error, `${label} failed.`), 'error');
      } finally {
        setPending(null);
      }
    },
    [refresh, refreshOnError, onToast, setFlow],
  );
  return { pending, setPending, run };
}

/** A pasted key or code arrives as one bracketed paste, not as keys: `append` gets it on one line. */
export function useMaskedPaste(active: boolean, append: (text: string) => void): void {
  usePaste((event) => {
    if (!active) return;
    const text = decodePasteBytes(event.bytes).replace(/[\r\n]+/g, '').trim();
    if (text) append(text);
  });
}
