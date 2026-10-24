/**
 * Where things live inside a session sandbox, for the parts that agree on it:
 * kortixd (which bundles this file), the image layers `@kortix/shared` writes,
 * and the `kortix` CLI. No imports: kortixd is a standalone binary.
 */

/** tmpfs directory kortixd writes the agent env file into. */
export const AGENT_ENV_DIR = '/dev/shm/kortix';
/** The agent env file. The image's shell profile sources it. */
export const AGENT_ENV_FILE = `${AGENT_ENV_DIR}/agent-env.sh`;

/** Managed-skill overlay root the image bakes and kortixd refreshes. */
export const MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills';
/** The runtime-asset bookkeeping the image bakes beside the overlay. */
export const RUNTIME_ASSETS_STATE_PATH = '/opt/kortix/runtime-assets-state.json';

/**
 * The read-only copy of a thread's memory pages (`project_channels`): one
 * folder per layer, `company`, `channel` and `personal`. kortixd replaces a
 * folder when the layer's version changes; agents write through `remember`.
 */
export const MEMORY_COPY_DIR = '/opt/kortix/memory';

/**
 * The files outside `apps/kortix-sandbox-agent-server` that kortixd bundles
 * into its binary, repo-relative. apps/api fingerprints them with the daemon
 * source, so a change to one rebuilds sandbox images, and the Dockerfiles copy
 * them. A kortixd test fails when the daemon imports a file not listed here.
 */
export const KORTIXD_SHARED_SOURCES = [
  'packages/shared/src/ssrf-guard.ts',
  'packages/api-contract/src/compiled-agent-config-env.ts',
  'packages/api-contract/src/egress-shim-rules.ts',
  'packages/api-contract/src/fallback-models.ts',
  'packages/api-contract/src/permission-rules.ts',
  'packages/api-contract/src/runtime-relay.ts',
  'packages/api-contract/src/sandbox-layout.ts',
  'packages/api-contract/src/secret-relay.ts',
  'packages/api-contract/src/session-log/capabilities.ts',
  'packages/api-contract/src/session-log/events.ts',
  'packages/api-contract/src/session-log/index.ts',
  'packages/api-contract/src/session-log/live.ts',
  'packages/api-contract/src/session-log/model-view.ts',
  'packages/api-contract/src/session-log/schema.ts',
  'packages/api-contract/src/session-log/types.ts',
  'packages/api-contract/src/session-log/v1.ts',
  'packages/api-contract/src/session-log/wire.ts',
  'packages/api-contract/src/transcript.ts',
  'packages/sdk/src/core/session/wire-message-id.ts',
] as const;
