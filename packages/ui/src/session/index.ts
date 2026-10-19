/**
 * @kortix/ui/session — the Kortix session thread for `@kortix/sdk` hosts.
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
