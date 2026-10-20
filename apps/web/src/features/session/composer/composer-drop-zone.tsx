'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ComponentProps, DragEvent } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type AcceptFiles = (files: File[]) => void;
type RegisterTarget = (accept: AcceptFiles) => () => void;

const ComposerDropZoneContext = createContext<RegisterTarget | null>(null);

const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * A file dropped anywhere in this area attaches to the composer inside it, not
 * only on the composer card. The session page wraps its whole column (header,
 * transcript, composer) in one.
 *
 * The zone claims a file drag only while its composer takes files
 * (`useComposerDropZone`). A disabled composer, or one locked to answer a
 * question, registers nothing, so `FileDropGuard` refuses the drag as before.
 * `dragenter`/`dragover` are claimed even when already cancelled: ProseMirror
 * cancels both inside the editor. A `drop` something nested already took is
 * left alone.
 */
export function ComposerDropZone({ className, children, ...props }: ComponentProps<'div'>) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const acceptRef = useRef<AcceptFiles | null>(null);
  // Counts the claimed `dragenter`s not yet left: moving between children
  // fires a leave for every enter.
  const depthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const register = useCallback<RegisterTarget>((accept) => {
    acceptRef.current = accept;
    return () => {
      if (acceptRef.current !== accept) return;
      acceptRef.current = null;
      depthRef.current = 0;
      setDragging(false);
    };
  }, []);

  const claims = (event: DragEvent) => acceptRef.current !== null && hasFiles(event);

  return (
    <ComposerDropZoneContext.Provider value={register}>
      <div
        {...props}
        className={cn('relative', className)}
        onDragEnter={(event) => {
          if (!claims(event)) return;
          event.preventDefault();
          depthRef.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!claims(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!hasFiles(event)) return;
          depthRef.current = Math.max(0, depthRef.current - 1);
          if (depthRef.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          depthRef.current = 0;
          setDragging(false);
          if (event.defaultPrevented || !claims(event)) return;
          event.preventDefault();
          const files = Array.from(event.dataTransfer.files ?? []);
          if (files.length > 0) acceptRef.current?.(files);
        }}
      >
        {children}
        {/* `pointer-events-none`: the drag keeps its real target underneath. */}
        {dragging && (
          <div
            aria-hidden
            data-composer-drop-overlay
            className="bg-background/80 pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
          >
            <span className="text-foreground bg-sidebar/80 rounded-md px-3 py-1.5 text-sm font-medium">
              {tHardcodedUi.raw('i18nComplete.text1ab1b095c1ed')}
            </span>
          </div>
        )}
      </div>
    </ComposerDropZoneContext.Provider>
  );
}

/**
 * Hands `accept` to the enclosing `ComposerDropZone` (`null`: this composer
 * takes no files right now). True inside a zone: the zone then owns every
 * file drag, and the card's own drop handlers stay off.
 */
export function useComposerDropZone(accept: AcceptFiles | null): boolean {
  const register = useContext(ComposerDropZoneContext);
  useEffect(() => {
    if (!register || !accept) return;
    return register(accept);
  }, [register, accept]);
  return register !== null;
}
