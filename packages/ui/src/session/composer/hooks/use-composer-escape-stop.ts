import { useEffect } from 'react';
import { SUGGESTION_MENU_SELECTOR } from '../esc-to-stop';

export function useComposerEscapeStop({
  editorElement,
  enabled,
  hasDraft,
  onStop,
}: {
  editorElement: HTMLElement | null;
  enabled: boolean;
  hasDraft: boolean;
  onStop?: () => void;
}) {
  useEffect(() => {
    if (!editorElement || !enabled || hasDraft || !onStop) return;
    let suggestionMenuWasOpen = false;
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        suggestionMenuWasOpen = document.querySelector(SUGGESTION_MENU_SELECTOR) !== null;
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.repeat || suggestionMenuWasOpen) return;
      // ProseMirror prevents every Escape, including one with no open menu.
      event.preventDefault();
      event.stopPropagation();
      onStop();
    };
    editorElement.addEventListener('keydown', capture, true);
    editorElement.addEventListener('keydown', keydown);
    return () => {
      editorElement.removeEventListener('keydown', capture, true);
      editorElement.removeEventListener('keydown', keydown);
    };
  }, [editorElement, enabled, hasDraft, onStop]);
}
