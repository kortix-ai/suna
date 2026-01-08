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
 * Returns true for rich editors (TipTap/ProseMirror/CodeMirror, contenteditable).
 *
 * Note: We intentionally do NOT treat plain inputs/textareas as "editable" here.
 * On the thread page, users almost always have focus in the chat textarea, and we
 * still want Cmd+I / Cmd+B to reliably toggle the Kortix Computer / left sidebar.
 */
function isEditableElementFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;

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
      // Intentionally do NOT close the Kortix Computer on Escape.
      // Escape is commonly used inside editors / in-panel UIs and should not dismiss the panel.
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

