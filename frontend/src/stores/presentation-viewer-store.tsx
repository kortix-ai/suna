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

export const usePresentationViewerStore = create<PresentationViewerState>()(
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

// Backward compatibility hook
export function usePresentationViewerContext() {
  const store = usePresentationViewerStore();
  
  return {
    openPresentation: store.openPresentation,
    closePresentation: store.closePresentation,
  };
}

// Hook for backward compatibility with usePresentationViewer
export function usePresentationViewer() {
  const store = usePresentationViewerStore();
  
  return {
    viewerState: {
      isOpen: store.isOpen,
      presentationName: store.presentationName,
      sandboxUrl: store.sandboxUrl,
      initialSlide: store.initialSlide,
    },
    openPresentation: store.openPresentation,
    closePresentation: store.closePresentation,
  };
}

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

