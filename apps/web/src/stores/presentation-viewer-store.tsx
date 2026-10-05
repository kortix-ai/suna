import { FullScreenPresentationViewer } from '@/features/file-renderers/presentation/FullScreenPresentationViewer';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

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

      openPresentation: (
        presentationName: string,
        sandboxUrl: string,
        initialSlide: number = 1,
      ) => {
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
    },
  ),
);

// Component wrapper to render the FullScreenPresentationViewer
export function PresentationViewerWrapper() {
  const isOpen = usePresentationViewerStore((s) => s.isOpen);
  const presentationName = usePresentationViewerStore((s) => s.presentationName);
  const sandboxUrl = usePresentationViewerStore((s) => s.sandboxUrl);
  const initialSlide = usePresentationViewerStore((s) => s.initialSlide);
  const closePresentation = usePresentationViewerStore((s) => s.closePresentation);

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
