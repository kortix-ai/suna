'use client';

/**
 * @kortix/sdk/react — OpenCode React hook surface.
 *
 * Barrel re-exporting EVERY hook, query-key factory, provider, and type from
 * the ported `use-opencode-*` / `use-*` hook modules. The web UI imports these
 * by exact name + return shape, so this file is the public contract — keep it
 * exhaustive and in parity with the source hooks.
 *
 * The 4 cross-module duplicates (`McpStatus`, `useOpenCodeMcpStatus`,
 * `ModelKey`, `useVisibleAgents`) are same-symbol re-exports (the secondary
 * module re-exports the primary's binding), so the overlapping `export *`
 * statements resolve to a single declaration with no ambiguity.
 */

export * from './use-opencode-sessions';
export * from './use-opencode-events';
export * from './use-opencode-local';
export * from './use-opencode-mcp';
export * from './use-opencode-pty';
export * from './use-opencode-config';
export * from './use-model-store';
export * from './use-model-hydration';
export * from './use-session-sync';
export * from './use-session-prefetch';
export * from './use-canonical-opencode-session';
export * from './use-gateway-catalog-sync';
export * from './use-visible-agents';
