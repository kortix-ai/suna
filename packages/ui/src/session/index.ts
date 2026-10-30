/**
 * @kortix/ui/session — The Kortix session thread for `@kortix/sdk` hosts.
 *
 * Drop-in (the thread apps/web renders):
 *
 *   const session = useSession(projectId, sessionId);
 *   return <SessionThread session={session} />;
 *
 * Building blocks, for a host that composes its own layout. Each one reads
 * `@kortix/sdk/react` and the host's <UiProvider> and <QueryClientProvider>.
 *
 * A custom tool row: `ToolRegistry.register('<tool name>', MyRow)`. `MyRow`
 * gets `ToolProps` (`call` is the session-log tool call) and can draw the
 * standard row with `BasicTool`, or fall back to `GenericTool`. A later
 * registration for the same name replaces the built-in one.
 *
 * Names are explicit (no `export *`): src/skill.test.ts checks that the
 * kortix-ui skill lists every one.
 */
import './tool/tools/register';

export { SessionThread, type SessionThreadProps } from './thread/session-thread';
export { UserMessage } from './turn/user-message';
export { ThrottledMarkdown } from './turn/throttled-markdown';
export { UnifiedMarkdown, type UnifiedMarkdownProps } from '../markdown/unified-markdown';
export { ToolPartRenderer } from './tool/tool-part-renderer';
export { ToolRegistry } from './tool/shared/registry';
export type { BasicToolProps, ToolComponent, ToolProps } from './tool/shared/types';
export { BasicTool } from './tool/shared/infrastructure-rows';
export { GenericTool } from './tool/generic-tool';
export { SessionChatInput, type SessionChatInputProps } from './composer/session-chat-input';
export { AgentSelector } from './composer/agent-selector';
export { ModelSelector, type ModelSelectorProps } from './models/model-selector';
export { SessionPermissionPrompt } from './prompts/session-permission-prompt';
export { QuestionPrompt, type QuestionPromptHandle } from './prompts/question-prompt';
export { TurnErrorDisplay } from './status/session-error-banner';
export { SessionBusyIndicator } from './status/session-busy-indicator';
export { SessionStartingLoader } from './status/session-starting-loader';
export { type SessionStatus } from '../internal/session-types/types';
export {
  UNTITLED_SESSION_LABEL,
  getSessionDisplayTitle,
  groupChangeRequestsBySession,
  hasSessionAwaitingTitle,
  isAwaitingTitle,
  projectSessionsRefetchInterval,
  resolveSessionListViewState,
  sessionLastActivityAt,
  sessionTitleHasLanded,
  shortRelative,
  sortSessionsByLastActivity,
  starterSectionOf,
} from './actions/project-session-list-helpers';
export { SessionDeleteModal } from './actions/session-delete-modal';
export {
  isLegacyMigratedSession,
  matchesSourceFilters,
  matchesStatusFilters,
  sessionDisplayLabel,
  sessionSource,
  type SessionSourceFilter,
} from './actions/session-label';
export { useRenameSession } from './actions/use-rename-session';
export { useSessionListActions } from './actions/use-session-list-actions';
export { CompactModal } from './header/compact-modal';
export { ProviderFailureRecovery } from './models/provider-failure-recovery';
export { useModelConnectionGate } from './models/use-model-connection-gate';
export {
  ApprovalAgentContext,
  ApprovalDecisionActions,
  ApprovalParameters,
  approvalReviewable,
  useApprovalWaitingText,
} from './prompts/approval-request';
export { SessionApprovalNotice } from './prompts/session-approval-prompt';
export { createScopedSession } from './scope/create-scoped-session';
export { SandboxLoadingBoundary } from './status/sandbox-loading-boundary';
export { SessionNoticeBanner } from './status/session-notice-banner';
export { SessionConnectingBanner } from './status/session-starting-loader';
export { ChatMinimap } from './thread/chat-minimap';
export { SessionChat } from './thread/session-chat';
export { SessionTurn, TranscriptTurnRow, TurnAssistantBlock } from './thread/transcript';
export { ToolSurfaceContext, partOutcome } from './tool/shared/infrastructure';
export { ToolOutcomeContext } from './tool/shared/infrastructure-contexts';
export { ToolOutputFallback } from './tool/shared/infrastructure-output';
export {
  ServicePreviewActions,
  type ServicePreviewState,
} from './tool/shared/infrastructure-preview';
export { ServicePreviewViewport } from './tool/shared/show-helpers';
export { ToolActivateContext, TurnLiveContext } from './tool/tool-renderers';
export { ActivityBurst } from './turn/activity-burst';
export { PlanCard } from './turn/plan-card';
export { TurnViewport } from './turn/turn-viewport';
export {
  ATTACHMENT_TILE_CAP,
  BUBBLE_SURFACE,
  ChannelOrigin,
  UserMessageBubble,
  mergeSentAttachments,
  normalizeAttachments,
  planAttachmentGrid,
  type ChannelMessage,
  type NormalizedAttachment,
} from './turn/user-message';
