/**
 * Pure compile step for the pi worker runtime artifact — the `engine: 'pi'`
 * sibling of ./compiled-runtime.ts (`engine: 'opencode'`).
 *
 * The artifact is one executable `.mjs`: a small prelude followed by the
 * generic worker runtime bundle (apps/kortix-worker). The prelude carries the
 * same self-description conventions as the opencode artifact so tooling can
 * treat both uniformly:
 *
 *   - line 2 is `// kortix-manifest-base64url:<manifest>` — parseable without
 *     executing anything;
 *   - `--manifest` prints the manifest and exits;
 *   - baked identity env vars fail closed (exit 78) when the environment
 *     disagrees with what this artifact was compiled from.
 *
 * What it does NOT share with the opencode artifact: no bun re-launcher (the
 * worker runs under plain node by design) and no config-dir archive (the
 * worker's whole point is that its config is already in memory — it is handed
 * to the runtime as `globalThis.__KORTIX_COMPILED__`, which
 * apps/kortix-worker/src/main.ts reads before starting).
 */
import { createHash } from 'node:crypto';

export const COMPILED_PI_RUNTIME_FORMAT = 'kortix.compiled-pi-runtime.v1' as const;
export const COMPILED_PI_RUNTIME_CONTENT_TYPE =
  'application/vnd.kortix.compiled-pi-runtime.v1+javascript';

export interface CompiledPiRuntimeManifest {
  format: typeof COMPILED_PI_RUNTIME_FORMAT;
  engine: 'pi';
  project_id: string;
  ref: string;
  source_sha: string;
  default_agent: string | null;
  agent_config: string | null;
  agent_config_etag: string | null;
}

export interface CompiledPiRuntimeArtifact {
  source: string;
  sha256: string;
  size: number;
  manifest: CompiledPiRuntimeManifest;
}

export interface CompilePiRuntimeInput {
  projectId: string;
  ref: string;
  sourceSha: string;
  /** Server-compiled agent config JSON (compile-agent-config.ts), or null for
   *  a project whose manifest is not `kortix_version: 2`. */
  agentConfig?: string | null;
  /** `default_agent` from the manifest at the compiled sha. */
  defaultAgent?: string | null;
  /** The generic worker runtime bundle (pi-worker-bundle.ts). */
  workerBundle: string;
}

function validateInput(input: CompilePiRuntimeInput): void {
  if (!input.projectId.trim()) throw new Error('projectId is required');
  if (!input.ref.trim()) throw new Error('ref is required');
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) {
    throw new Error('sourceSha must be a lowercase 40-character Git SHA');
  }
  if (input.agentConfig) JSON.parse(input.agentConfig);
  if (!input.workerBundle.trim()) throw new Error('workerBundle is required');
}

function etag(value: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function runtimeSource(manifest: CompiledPiRuntimeManifest, workerBundle: string): string {
  const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64url');
  return `#!/usr/bin/env node
// kortix-manifest-base64url:${encodedManifest}
export const manifest = Object.freeze(
  JSON.parse(Buffer.from("${encodedManifest}", "base64url").toString("utf8")),
);

if (process.argv.includes("--manifest")) {
  process.stdout.write(JSON.stringify(manifest) + "\\n");
  process.exit(0);
}

const compiledEnv = {
  KORTIX_COMPILED_RUNTIME_FORMAT: manifest.format,
  KORTIX_COMPILED_RUNTIME_SOURCE_SHA: manifest.source_sha,
  KORTIX_PROJECT_ID: manifest.project_id,
  KORTIX_BASE_REF: manifest.ref,
  KORTIX_BASE_SHA: manifest.source_sha,
};

for (const [name, value] of Object.entries(compiledEnv)) {
  const runtimeValue = process.env[name];
  if (runtimeValue !== undefined && runtimeValue !== value) {
    process.stderr.write("Compiled pi runtime identity mismatch for " + name + "\\n");
    process.exit(78);
  }
}

Object.assign(process.env, compiledEnv);

globalThis.__KORTIX_COMPILED__ = {
  manifest,
  agentConfig: manifest.agent_config ? JSON.parse(manifest.agent_config) : null,
};

${workerBundle}
`;
}

export function compilePiRuntime(input: CompilePiRuntimeInput): CompiledPiRuntimeArtifact {
  validateInput(input);
  const agentConfig = input.agentConfig ?? null;
  const manifest: CompiledPiRuntimeManifest = {
    format: COMPILED_PI_RUNTIME_FORMAT,
    engine: 'pi',
    project_id: input.projectId,
    ref: input.ref,
    source_sha: input.sourceSha,
    default_agent: input.defaultAgent ?? null,
    agent_config: agentConfig,
    agent_config_etag: etag(agentConfig),
  };
  const source = runtimeSource(manifest, input.workerBundle);
  return {
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    size: Buffer.byteLength(source),
    manifest,
  };
}
