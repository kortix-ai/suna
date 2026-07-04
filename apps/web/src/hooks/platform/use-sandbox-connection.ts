'use client';

/**
 * Thin re-export — the mid-session runtime reconnect poller now lives in the
 * SDK (`@kortix/sdk/react`'s `useRuntimeReconnect`, implemented in
 * `packages/sdk/src/react/use-runtime-reconnect.ts`) since it's pure
 * probe/store logic with no web-specific dependency. Kept at this path/name so
 * existing web imports (`@/hooks/platform/use-sandbox-connection`) don't need
 * to change.
 */
export { useRuntimeReconnect as useSandboxConnection } from '@kortix/sdk/react';
