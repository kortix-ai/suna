import { useState, useEffect } from 'react';

interface PresentationViewerModalState {
  isOpen: boolean;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
}

// Simple global state for the presentation viewer modal
let globalState: PresentationViewerModalState = {
  isOpen: false,
};

const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(listener => listener());
}

export function usePresentationViewerModal() {
  const [state, setState] = useState<PresentationViewerModalState>(globalState);

  useEffect(() => {
    const listener = () => {
      setState({ ...globalState });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const openPresentation = (
    presentationName: string,
    sandboxUrl: string,
    initialSlide: number = 1
  ) => {
    globalState = {
      isOpen: true,
      presentationName,
      sandboxUrl,
      initialSlide,
    };
    notifyListeners();
  };

  const closePresentation = () => {
    globalState = {
      isOpen: false,
    };
    notifyListeners();
  };

  return {
    viewerState: state,
    openPresentation,
    closePresentation,
  };
}

