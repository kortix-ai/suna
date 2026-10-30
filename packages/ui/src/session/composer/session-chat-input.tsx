/**
 * The composer's barrel: `@kortix/ui/session` re-exports the composer
 * (`SessionChatInput`, `AgentSelector`) from here. The implementation is
 * `./composer.tsx`. `flattenModels`/`FlatModel` come from `@kortix/sdk/react`.
 */
export { AgentSelector, agentDisplayLabel } from './agent-selector';
export { Composer as SessionChatInput, type SessionChatInputProps } from './composer';
export type { AttachedFile, TrackedMention } from './types';
