/**
 * OpenCode Library — main entry point.
 *
 * Re-exports all types, hooks, stores, and utilities needed to build
 * the Computer mobile app's session-based UI.
 */

// Types
export * from './types';

// Turn grouping & helpers (framework-agnostic)
export * from './turns';

// Zustand sync store (single source of truth for messages)
export { useSyncStore } from './sync-store';

// SSE event stream hook
export { useOpenCodeEventStream } from './event-stream';

// Session sync hook (hydrates messages on mount)
export { useSessionSync } from './session-sync';
