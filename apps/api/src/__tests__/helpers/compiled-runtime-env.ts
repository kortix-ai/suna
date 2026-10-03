import type { CompiledRuntimeManifest } from '../../git-proxy/compiled-runtime';
import type { CompiledPiRuntimeManifest } from '../../git-proxy/compiled-pi-runtime';

/**
 * The env a production runner provides to a compiled runtime: exactly the
 * baked manifest's identity fields, nothing else.
 *
 * Without pinning, a spawned runtime inherits the test worker's whole
 * process.env, and any test in the same worker that promotes the platform's
 * agent-env.sh values into process.env flips the runtime's identity check
 * mid-suite (order-dependent, invisible when the file runs alone).
 */
export function runnerEnv(
  artifact: { manifest: CompiledRuntimeManifest | CompiledPiRuntimeManifest },
): Record<string, string> {
  const m = artifact.manifest;
  return {
    KORTIX_COMPILED_RUNTIME_FORMAT: m.format,
    KORTIX_COMPILED_RUNTIME_SOURCE_SHA: m.source_sha,
    KORTIX_PROJECT_ID: m.project_id,
    KORTIX_DEFAULT_BRANCH: m.ref,
    KORTIX_BASE_REF: m.ref,
    KORTIX_BASE_SHA: m.source_sha,
    ...(m.agent_config && m.agent_config_etag
      ? {
          KORTIX_COMPILED_AGENT_CONFIG: m.agent_config,
          KORTIX_COMPILED_AGENT_CONFIG_ETAG: m.agent_config_etag,
        }
      : {}),
  };
}
