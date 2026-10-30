'use client';

import { Modal, ModalContent, ModalTitle } from '@kortix/ui/modal';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@kortix/ui/resizable';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { artifactDiscussionStorage } from './artifact-discussion-storage';

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
  const storage = useMemo(() => artifactDiscussionStorage(viewerId), [viewerId]);
  const overlay = embedded || narrow;
  return (
    <>
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
              defaultSize={30}
              minSize={22}
              maxSize={45}
            >
              <aside className="bg-background h-full min-h-0 border-l" aria-label={title}>
                {discussion}
              </aside>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      {overlay ? (
        <Modal open={open} onOpenChange={onOpenChange}>
          <ModalContent
            side="right"
            variant="base"
            closeLabel={closeLabel}
            aria-describedby={undefined}
            className="!inset-y-0 !right-0 !left-auto !flex !h-full !max-h-none !w-full !max-w-sm !translate-x-0 !translate-y-0 !flex-col !space-y-0 overflow-clip !rounded-none"
          >
            <ModalTitle className="sr-only">{title}</ModalTitle>
            <div className="min-h-0 flex-1 [&_[data-artifact-discussion-header]]:pr-14">
              {discussion}
            </div>
          </ModalContent>
        </Modal>
      ) : null}
    </>
  );
}
