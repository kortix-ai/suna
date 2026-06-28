/**
 * Sandbox URL detection / rewriting / proxy utilities.
 *
 * Moved into the SDK — this is a thin re-export of `@kortix/sdk/session/url`,
 * the single source of truth, verified against the current Sandbox Agent
 * Server's `/proxy/:port` + `/web-proxy` surface. Import from here or directly
 * from `@kortix/sdk/session`.
 */
export * from '@kortix/sdk/session/url';
