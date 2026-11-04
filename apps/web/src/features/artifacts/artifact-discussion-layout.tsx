'use client';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@kortix/ui/resizable';
import { SplitSheet, SplitSheetContent, SplitSheetMain } from '@kortix/ui/split-sheet';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { artifactDiscussionStorage } from './artifact-discussion-storage';

/** The docked panel never narrows below this, in CSS px. */
const PANEL_MIN_PX = 320;
/** `SplitSheet` puts its panel beside the page from a 48rem root (`@3xl/split-sheet`); below that the panel covers the page. */
const SPLIT_MIN_REM = 48;

/**
 * Where the discussion renders:
 * - `docked`: a resizable column beside the artifact (wide standalone viewer).
 * - `split`: a non-modal column beside the artifact (embedded viewer, or a window below `lg`).
 * - `cover`: the same non-modal panel over the artifact cell, when the root is narrower than 48rem.
 * `close` exists only for `split` and `cover`: the docked column closes from the viewer's header toggle.
 */
export interface ArtifactDiscussionPanel {
  mode: 'docked' | 'split' | 'cover';
  close?: () => void;
  closeLabel?: string;
}

const PanelContext = createContext<ArtifactDiscussionPanel>({ mode: 'docked' });

export function useArtifactDiscussionPanel(): ArtifactDiscussionPanel {
  return useContext(PanelContext);
}

/** The docked panel's minimum size in percent of the group width: 320 px, within 22–45%. */
export function discussionPanelMinSize(groupWidth: number): number {
  if (!(groupWidth > 0)) return 22;
  return Math.min(45, Math.max(22, (PANEL_MIN_PX / groupWidth) * 100));
}

export function ArtifactDiscussionLayout({
  children,
  discussion,
  open,
  onOpenChange,
  embedded,
  viewerId,
  title,
  closeLabel,
  resizeLabel,
}: {
  children: ReactNode;
  discussion: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded: boolean;
  viewerId?: string;
  title: string;
  closeLabel: string;
  resizeLabel: string;
}) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, cover: false });
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      const rem =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      setSize({ width, cover: width > 0 && width < SPLIT_MIN_REM * rem });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const storage = useMemo(() => artifactDiscussionStorage(viewerId), [viewerId]);
  const overlay = embedded || narrow;
  const { cover } = size;
  const minSize = discussionPanelMinSize(size.width);
  const panel = useMemo<ArtifactDiscussionPanel>(
    () =>
      overlay
        ? { mode: cover ? 'cover' : 'split', close: () => onOpenChange(false), closeLabel }
        : { mode: 'docked' },
    [overlay, cover, onOpenChange, closeLabel],
  );
  // One tree for every mode: the artifact keeps its place, so a resize never reloads its frame or editor.
  return (
    <div ref={frame} className="flex min-h-0 min-w-0 flex-1">
      <SplitSheet open={overlay && open} onOpenChange={onOpenChange} size="sm">
        <SplitSheetMain className="flex">
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId={viewerId ? 'artifact-discussion' : undefined}
            storage={storage}
            className="min-h-0 min-w-0 flex-1"
          >
            <ResizablePanel id="artifact-content" order={1} minSize={50} className="flex min-w-0">
              {children}
            </ResizablePanel>
            {open && !overlay ? (
              <>
                <ResizableHandle aria-label={resizeLabel} />
                <ResizablePanel
                  id="artifact-discussion"
                  order={2}
                  defaultSize={Math.max(30, minSize)}
                  minSize={minSize}
                  maxSize={45}
                >
                  <aside className="bg-background h-full min-h-0 border-l" aria-label={title}>
                    <PanelContext.Provider value={panel}>{discussion}</PanelContext.Provider>
                  </aside>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </SplitSheetMain>
        <SplitSheetContent aria-label={title} aria-labelledby={undefined}>
          <PanelContext.Provider value={panel}>{discussion}</PanelContext.Provider>
        </SplitSheetContent>
      </SplitSheet>
    </div>
  );
}
