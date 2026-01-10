export { ThreadContent } from './ThreadContent';
export type { ToolMessagePair } from './ThreadContent';
export { ChatInput } from './ChatInput';
export { 
  FileAttachmentRenderer, 
  FileAttachmentsGrid,
  extractFileReferences,
  removeFileReferences,
} from './FileAttachmentRenderer';
export type { ChatInputRef } from './ChatInput';
export { StreamingToolCard } from './StreamingToolCard';
export { CompactToolCard, CompactStreamingToolCard } from './CompactToolCard';
export { MediaGenerationInline } from './MediaGenerationInline';
export { ToolSnack, extractLastToolFromMessages, extractToolFromStreamingMessage } from './ToolSnack';
export type { ToolSnackData } from './ToolSnack';

export { ChatInputSection, ChatDrawers, CHAT_INPUT_SECTION_HEIGHT } from './shared';
export type { ChatInputSectionProps, ChatInputSectionRef, ChatDrawersProps } from './shared';
