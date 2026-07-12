/**
 * Runtime library — main entry point.
 *
 * Re-exports the types, hooks, stores, and utilities needed to build the
 * mobile app's session-based UI.
 */

// Types
export * from './types';

// Zustand sync store (single source of truth for messages)
export { useSyncStore } from './sync-store';
