/**
 * Version key builders for sandbox runtime fingerprinting.
 *
 * Extracted to a separate module (no config/db dependencies) so they can be
 * imported in tests without module-load side effects.
 */

import {
  AGENT_BROWSER_VERSION,
  CLAUDE_AGENT_ACP_VERSION,
  CODEX_ACP_VERSION,
  OPENCODE_VERSION,
  PI_ACP_VERSION,
  PI_CODING_AGENT_VERSION,
} from '@kortix/shared';

/**
 * Folded harness version key: all pinned ACP adapter versions.
 * Format: `oc:<v>:claude-acp:<v>:codex-acp:<v>:pi-acp:<v>:pi:<v>`
 */
export const harnessVersionKey = () => [
  `oc:${OPENCODE_VERSION}`,
  `claude-acp:${CLAUDE_AGENT_ACP_VERSION}`,
  `codex-acp:${CODEX_ACP_VERSION}`,
  `pi-acp:${PI_ACP_VERSION}`,
  `pi:${PI_CODING_AGENT_VERSION}`,
].join(':');

/**
 * Sandbox version string used in fingerprinting.
 * Format: `<sandbox-version>:layer:<layer-version>:harnesses:<harness-key>:ab:<browser-version>`
 * Requires SANDBOX_VERSION and RUNTIME_LAYER_VERSION from config.
 */
export const sandboxVersionStr = (sandboxVersion: string, runtimeLayerVersion: string) =>
  `${sandboxVersion}:layer:${runtimeLayerVersion}:harnesses:${harnessVersionKey()}:ab:${AGENT_BROWSER_VERSION}`;
