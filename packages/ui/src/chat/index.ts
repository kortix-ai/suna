/**
 * @kortix/ui/chat — the Kortix chat for `@kortix/sdk` sessions.
 *
 *   const session = useSession(projectId, sessionId);
 *   return <SessionThread session={session} />;
 *
 * Every piece is exported, so a host can compose its own layout from
 * MessageList, MessageView, Composer and the prompts.
 */
export { AgentPicker } from './agent-picker';
export { Composer, type ComposerCommand, parseCommand, slashQuery } from './composer';
export { Markdown } from './markdown';
export { DefaultEmptyState, MessageList } from './message-list';
export { type MessageRenderers, MessageView, type RenderTool } from './message-view';
export { filterModels, ModelPicker } from './model-picker';
export { type ChatErrorHandler, type PermissionDecision, PermissionPrompt } from './permission-prompt';
export { QuestionPrompt } from './question-prompt';
export { sendFailureTitle } from './send-failure';
export { SessionPickers, SessionThread, type SessionThreadProps } from './session-thread';
export {
  closeUnterminatedCodeFence,
  holdBackFenceOpener,
  holdBackTableHeader,
  streamingMarkdown,
} from './streaming-markdown';
export { ToolCall } from './tool-call';
export { userMessageParts } from './user-message-parts';
