import { useEffect } from 'react';

interface UseKeyboardShortcutsProps {
  isSidePanelOpen: boolean;
  setIsSidePanelOpen: (open: boolean) => void;
  leftSidebarState: string;
  setLeftSidebarOpen: (open: boolean) => void;
  userClosedPanelRef: React.MutableRefObject<boolean>;
}

export function useKeyboardShortcuts({
  isSidePanelOpen,
  setIsSidePanelOpen,
  leftSidebarState,
  setLeftSidebarOpen,
  userClosedPanelRef,
}: UseKeyboardShortcutsProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        if (isSidePanelOpen) {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
        } else {
          setIsSidePanelOpen(true);
          setLeftSidebarOpen(false);
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        if (leftSidebarState === 'expanded') {
          setLeftSidebarOpen(false);
        } else {
          setLeftSidebarOpen(true);
          if (isSidePanelOpen) {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
          }
        }
      }

      if (event.key === 'Escape' && isSidePanelOpen) {
        setIsSidePanelOpen(false);
        userClosedPanelRef.current = true;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSidePanelOpen, leftSidebarState, setLeftSidebarOpen, setIsSidePanelOpen, userClosedPanelRef]);
} 