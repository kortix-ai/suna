import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import React from 'react';
import { FullScreenPresentationViewer } from '@/components/thread/tool-views/presentation-tools/FullScreenPresentationViewer';

interface PresentationViewerState {
  isOpen: boolean;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
  
  openPresentation: (presentationName: string, sandboxUrl: string, initialSlide?: number) => void;
  closePresentation: () => void;
}

const usePresentationViewerStore = create<PresentationViewerState>()(
  devtools(
    (set) => ({
      isOpen: false,
      presentationName: undefined,
      sandboxUrl: undefined,
      initialSlide: undefined,
      
      openPresentation: (presentationName: string, sandboxUrl: string, initialSlide: number = 1) => {
        set({
          isOpen: true,
          presentationName,
          sandboxUrl,
          initialSlide,
        });
      },
      
      closePresentation: () => {
        set({
          isOpen: false,
          presentationName: undefined,
          sandboxUrl: undefined,
          initialSlide: undefined,
        });
      },
    }),
    {
      name: 'presentation-viewer-store',
    }
  )
);

// Component wrapper to render the FullScreenPresentationViewer
export function PresentationViewerWrapper() {
  const { isOpen, presentationName, sandboxUrl, initialSlide, closePresentation } = usePresentationViewerStore();
  
  return (
    <FullScreenPresentationViewer
      isOpen={isOpen}
      onClose={closePresentation}
      presentationName={presentationName}
      sandboxUrl={sandboxUrl}
      initialSlide={initialSlide}
    />
  );
}
