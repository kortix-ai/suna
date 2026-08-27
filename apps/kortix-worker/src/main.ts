/**
 * Bundle entrypoint for the compiled worker runtime.
 *
 * The API's compiled-boot pipeline prepends one line before this bundle:
 *
 *   globalThis.__KORTIX_COMPILED__ = { manifest, agentConfig }
 *
 * where `manifest` identifies the exact (project, ref, sha) this artifact was
 * compiled from and `agentConfig` is the server-compiled agent map
 * (`{ model?, agent: { <name>: { prompt, model, ... } } }`) read from
 * `kortix.yaml` + each agent's `.md` at that sha. So the worker boots with its
 * agent already in memory — no clone, no config resolution, no network before
 * the first model call.
 *
 * Environment variables still win over baked config: the control plane knows
 * things at session-start time (model override, session id, environment URL)
 * that a per-commit artifact cannot.
 */
import { configFromEnv, startWorker, type WorkerConfig } from './worker.ts';

interface CompiledPayload {
  manifest?: {
    project_id?: string;
    ref?: string;
    source_sha?: string;
    default_agent?: string | null;
  };
  agentConfig?: {
    model?: string;
    agent?: Record<string, { prompt?: string; model?: string; description?: string }>;
  } | null;
}

function bakedOverlay(cfg: WorkerConfig): WorkerConfig {
  const compiled = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
    | CompiledPayload
    | undefined;
  if (!compiled) return cfg;

  const agents = compiled.agentConfig?.agent ?? {};
  const agentName =
    process.env.KORTIX_AGENT ?? compiled.manifest?.default_agent ?? Object.keys(agents)[0];
  const agent = agentName ? agents[agentName] : undefined;

  const out = { ...cfg };
  // The baked prompt applies only when the env did not set one — the env var
  // is a session-start override, the bake is the commit's truth.
  if (!process.env.KORTIX_SYSTEM_PROMPT && agent?.prompt) out.systemPrompt = agent.prompt;
  // Agent model strings are opencode-shaped: "<providerID>/<modelID...>".
  const model = agent?.model ?? compiled.agentConfig?.model;
  if (!process.env.KORTIX_MODEL && model?.includes('/')) {
    const slash = model.indexOf('/');
    out.providerId = model.slice(0, slash);
    out.modelId = model.slice(slash + 1);
  }
  return out;
}

const compiled = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
  | CompiledPayload
  | undefined;
console.log(
  JSON.stringify({
    msg: 'kortix-worker starting',
    compiled: compiled?.manifest
      ? {
          project: compiled.manifest.project_id,
          ref: compiled.manifest.ref,
          sha: compiled.manifest.source_sha,
        }
      : null,
  }),
);

startWorker(bakedOverlay(configFromEnv())).catch((err) => {
  console.error(JSON.stringify({ msg: 'kortix-worker fatal', error: String(err?.message ?? err) }));
  process.exit(1);
});
