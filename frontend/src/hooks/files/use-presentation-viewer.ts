import { useState } from 'react';

interface PresentationViewerState {
  isOpen: boolean;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
}

export function usePresentationViewer() {
  const [viewerState, setViewerState] = useState<PresentationViewerState>({
    isOpen: false,
  });

  const openPresentation = (
    presentationName: string,
    sandboxUrl: string,
    initialSlide: number = 1
  ) => {
    setViewerState({
      isOpen: true,
      presentationName,
      sandboxUrl,
      initialSlide,
    });
  };

  const closePresentation = () => {
    setViewerState({
      isOpen: false,
    });
  };

  return {
    viewerState,
    openPresentation,
    closePresentation,
  };
}
