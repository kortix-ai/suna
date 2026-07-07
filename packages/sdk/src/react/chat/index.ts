'use client';

// Headless chat bindings — `classifyTurn`/`classifyPart`-driven view models
// for building custom chat UIs on top of `@kortix/sdk`. Re-exported from the
// main `@kortix/sdk/react` barrel; no separate subpath needed.
export { useChatTurns, type TurnView } from './use-chat-turns';
export { renderParts, type PartRenderers } from './render-parts';
