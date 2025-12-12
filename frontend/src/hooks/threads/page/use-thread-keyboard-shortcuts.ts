import { useEffect } from 'react';

interface UseKeyboardShortcutsProps {
  isSidePanelOpen: boolean;
  setIsSidePanelOpen: (open: boolean) => void;
  leftSidebarState: string;
  setLeftSidebarOpen: (open: boolean) => void;
  userClosedPanelRef: React.MutableRefObject<boolean>;
}

/**
 * Checks if user is currently focused on an editable element.
 * Returns true for editors, inputs, textareas, and contenteditable elements.
 */
function isEditableElementFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;

  const tagName = el.tagName.toLowerCase();

  // Input fields and textareas
  if (tagName === 'input' || tagName === 'textarea') return true;

  // Contenteditable elements (TipTap/ProseMirror)
  if (el.getAttribute('contenteditable') === 'true') return true;

  // CodeMirror uses a hidden textarea or contenteditable div
  // Check if we're inside a CodeMirror editor
  if (el.closest('.cm-editor')) return true;

  // Check for ProseMirror class (TipTap)
  if (el.closest('.ProseMirror')) return true;

  return false;
}

export function useThreadKeyboardShortcuts({
  isSidePanelOpen,
  setIsSidePanelOpen,
  leftSidebarState,
  setLeftSidebarOpen,
  userClosedPanelRef,
}: UseKeyboardShortcutsProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;

      // Skip sidebar shortcuts if user is in an editable element
      // This lets editors handle cmd+b (bold), cmd+i (italic), etc.
      if (isEditableElementFocused()) {
        // Don't handle cmd+b or cmd+i - let the editor handle them
        if (isMod && (event.key === 'b' || event.key === 'i')) {
          return;
        }
      }

      // cmd+i toggles right side panel (only when not editing)
      if (isMod && event.key === 'i') {
        event.preventDefault();
        if (isSidePanelOpen) {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
        } else {
          setIsSidePanelOpen(true);
          setLeftSidebarOpen(false);
        }
        return;
      }

      // cmd+b toggles left sidebar (only when not editing)
      if (isMod && event.key === 'b') {
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
        return;
      }

      // Escape closes side panel
      if (event.key === 'Escape' && isSidePanelOpen) {
        setIsSidePanelOpen(false);
        userClosedPanelRef.current = true;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isSidePanelOpen,
    leftSidebarState,
    setLeftSidebarOpen,
    setIsSidePanelOpen,
    userClosedPanelRef,
  ]);
}

