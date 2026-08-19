/**
 * Session chat input — public barrel. The real implementation moved to
 * `./composer/composer.tsx` (Task 13 of the composer rebuild); this file
 * exists only so the many existing `from '@/features/session/
 * session-chat-input'` importers keep resolving unchanged. `MentionItem` and
 * `ProviderListResponse` are deliberately NOT re-exported here — neither has
 * a real importer through this path (both were only used internally by the
 * now-deleted `SessionChatInputImpl`/its popovers; every live
 * `ProviderListResponse` user already imports it straight from
 * `@kortix/sdk/react`).
 */
export { AgentSelector } from './composer/agent-selector';
export { Composer as SessionChatInput, type SessionChatInputProps } from './composer/composer';
export type { AttachedFile, TrackedMention } from './composer/types';
export { flattenModels, type FlatModel } from './model-flatten';
