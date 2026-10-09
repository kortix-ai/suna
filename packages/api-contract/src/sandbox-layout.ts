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
 * The argv OpenCode runs for the `kortix-connectors` MCP server. `connectors`
 * must be a real CLI command: the singular `connector` shipped on 2026-08-06
 * and the server never started for six days.
 */
export const CONNECTORS_MCP_COMMAND = ['/usr/local/bin/kortix', 'connectors', 'mcp'] as const;

/**
 * The files outside `apps/kortix-sandbox-agent-server` that kortixd bundles
 * into its binary, repo-relative. apps/api fingerprints them with the daemon
 * source, so a change to one rebuilds sandbox images, and the Dockerfiles copy
 * them. A kortixd test fails when the daemon imports a file not listed here.
 */
export const KORTIXD_SHARED_SOURCES = [
  'packages/api-contract/src/egress-shim-rules.ts',
  'packages/api-contract/src/fallback-models.ts',
  'packages/api-contract/src/runtime-relay.ts',
  'packages/api-contract/src/sandbox-layout.ts',
  'packages/api-contract/src/secret-relay.ts',
  'packages/api-contract/src/transcript.ts',
  'packages/sdk/src/core/session/wire-message-id.ts',
  // The generative-UI prompt (`@kortix/sdk/genui`) and every file it imports.
  'packages/sdk/src/genui/catalog.ts',
  'packages/sdk/src/genui/fence.ts',
  'packages/sdk/src/genui/index.ts',
  'packages/sdk/src/genui/markdown.ts',
  'packages/sdk/src/genui/parse.ts',
  'packages/sdk/src/genui/prompt.ts',
  'packages/sdk/src/genui/share.ts',
  'packages/sdk/src/genui/types.ts',
  'packages/sdk/src/genui/urls.ts',
  'packages/sdk/src/genui/validate.ts',
] as const;
