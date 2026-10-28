/**
 * @kortix/ui/composer — The message composer: the drop-in inputs, their chrome, the
 * tiptap editor parts and the send pipeline, for a host that builds its own composer.
 */
export { ComposerAboveCard } from './ComposerAboveCard';
export { ComposerCard } from './ComposerCard';
export { AgentSelector, agentDisplayLabel } from './agent-selector';
export {
  captureAttachmentSubmission,
  runComposerSend,
  type AttachmentSubmission,
} from './attachment-submission';
export {
  COMMAND_CHIP_ATTRIBUTE,
  COMMAND_CHIP_LABEL_ATTRIBUTE,
  COMMAND_CHIP_SELECTOR,
  COMMAND_CHIP_VALUE,
  draftWillRunCommand,
  planCommandAttachments,
  planUnresolvedCommandChip,
  readCommandChipLabel,
} from './command-attachments';
export { COMPOSER_INPUT_SLOT_CLASS, COMPOSER_SHELL_CLASS, Composer } from './composer';
export { ComposerChatInput, type ComposerOptions } from './composer-chat-input';
export { ComposerDropZone } from './composer-drop-zone';
export { ComposerUnderbar } from './composer-underbar';
export { type DraftScope } from './draft/composer-draft';
export { ComposerEditor, type ComposerEditorHandle } from './editor/composer-editor';
export { baseExtensions } from './editor/extensions';
export { MentionNode } from './editor/mention-node';
export { baseSuggestion, type MenuController } from './editor/suggestion';
export { ReasoningEffortSelector } from './reasoning-effort-selector';
export { SessionChatInput, type SessionChatInputProps } from './session-chat-input';
export { useFirstPromptPreviewStore } from './stores/session-composer-handoff-store';
export { useSessionComposerPrefillStore } from './stores/session-composer-prefill-store';
export { createSubmitLatch } from './submit-latch';
export { type AttachedFile } from './types';
