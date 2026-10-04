import { createHash } from 'node:crypto';

export const COMPILED_RUNTIME_FORMAT = 'kortix.compiled-runtime.v1' as const;
export const COMPILED_RUNTIME_CONTENT_TYPE =
  'application/vnd.kortix.compiled-runtime.v1+javascript';

export interface CompiledRuntimeManifest {
  format: typeof COMPILED_RUNTIME_FORMAT;
  engine: 'opencode';
  project_id: string;
  ref: string;
  source_sha: string;
  agent_config: string | null;
  agent_config_etag: string | null;
  opencode_config_dir: string | null;
  opencode_config_archive_sha256: string | null;
  opencode_config_archive_bytes: number | null;
}

export interface CompiledRuntimeArtifact {
  source: string;
  sha256: string;
  size: number;
  manifest: CompiledRuntimeManifest;
}

export interface CompileOpenCodeRuntimeInput {
  projectId: string;
  ref: string;
  sourceSha: string;
  agentConfig?: string | null;
  agentBundle: string;
  opencodeConfigDir?: string | null;
  opencodeConfigArchiveBase64?: string | null;
}

function validateInput(input: CompileOpenCodeRuntimeInput): void {
  if (!input.projectId.trim()) throw new Error('projectId is required');
  if (!input.ref.trim()) throw new Error('ref is required');
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) {
    throw new Error('sourceSha must be a lowercase 40-character Git SHA');
  }
  if (input.agentConfig) JSON.parse(input.agentConfig);
  if (!input.agentBundle.trim()) throw new Error('agentBundle is required');
  if (Boolean(input.opencodeConfigDir) !== Boolean(input.opencodeConfigArchiveBase64)) {
    throw new Error('opencodeConfigDir and opencodeConfigArchiveBase64 must be supplied together');
  }
}

function etag(value: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function runtimeSource(
  manifest: CompiledRuntimeManifest,
  agentBundle: string,
  opencodeConfigArchiveBase64: string | null,
): string {
  const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64url');
  return `#!/usr/bin/env bun
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
  KORTIX_DEFAULT_BRANCH: manifest.ref,
  KORTIX_BASE_REF: manifest.ref,
  KORTIX_BASE_SHA: manifest.source_sha,
  ...(manifest.agent_config
    ? {
        KORTIX_COMPILED_AGENT_CONFIG: manifest.agent_config,
        KORTIX_COMPILED_AGENT_CONFIG_ETAG: manifest.agent_config_etag,
      }
    : {}),
};

for (const [name, value] of Object.entries(compiledEnv)) {
  const runtimeValue = process.env[name];
  if (runtimeValue !== undefined && runtimeValue !== value) {
    process.stderr.write(
      "Compiled runtime identity mismatch for " + name + "\\n",
    );
    process.exit(78);
  }
}

Object.assign(process.env, compiledEnv);

if (typeof globalThis.Bun === "undefined") {
  const { spawn } = await import("node:child_process");
  const executable = process.env.KORTIX_BUN_BIN || "/home/kortix/.bun/bin/bun";
  const child = spawn(executable, [process.argv[1], ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  const result = await new Promise((resolve) => {
    child.once("error", (error) => {
      process.stderr.write("Failed to start compiled Kortix daemon: " + error.message + "\\n");
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) {
    process.stderr.write("Compiled Kortix daemon exited from signal " + result.signal + "\\n");
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

const opencodeConfigArchiveBase64 = ${JSON.stringify(opencodeConfigArchiveBase64)};
if (opencodeConfigArchiveBase64 && manifest.opencode_config_archive_sha256) {
  const { createHash } = await import("node:crypto");
  const { access, mkdir, readFile, rename, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const archive = Buffer.from(opencodeConfigArchiveBase64, "base64");
  const actualSha = createHash("sha256").update(archive).digest("hex");
  if (actualSha !== manifest.opencode_config_archive_sha256) {
    throw new Error("Compiled OpenCode config checksum mismatch");
  }
  const root = process.env.KORTIX_COMPILED_CONFIG_ROOT || "/dev/shm/kortix-compiled-config";
  const target = join(root, actualSha.slice(0, 24));
  const marker = join(target, ".kortix-config-sha256");
  let ready = false;
  try {
    ready = (await readFile(marker, "utf8")).trim() === actualSha;
  } catch {}
  if (!ready) {
    await mkdir(root, { recursive: true });
    const staged = target + "." + crypto.randomUUID() + ".tmp";
    const archivePath = staged + ".tar.gz";
    try {
      await mkdir(staged, { recursive: true });
      await writeFile(archivePath, archive, { mode: 0o600 });
      const extract = Bun.spawn(["tar", "-xzf", archivePath, "-C", staged], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderrPromise = new Response(extract.stderr).text();
      const exitCode = await extract.exited;
      const stderr = await stderrPromise;
      if (exitCode !== 0) throw new Error("OpenCode config extraction failed: " + stderr.trim());
      await writeFile(join(staged, ".kortix-config-sha256"), actualSha + "\\n", { mode: 0o600 });
      try {
        await rename(staged, target);
      } catch (error) {
        await access(marker);
      }
    } finally {
      await rm(staged, { recursive: true, force: true });
      await rm(archivePath, { force: true });
    }
  }
  process.env.KORTIX_COMPILED_OPENCODE_CONFIG_DIR = target;
}

${agentBundle}
`;
}

export function compileOpenCodeRuntime(
  input: CompileOpenCodeRuntimeInput,
): CompiledRuntimeArtifact {
  validateInput(input);
  const agentConfig = input.agentConfig ?? null;
  const opencodeConfigArchiveBase64 = input.opencodeConfigArchiveBase64 ?? null;
  const opencodeConfigArchive = opencodeConfigArchiveBase64
    ? Buffer.from(opencodeConfigArchiveBase64, 'base64')
    : null;
  const manifest: CompiledRuntimeManifest = {
    format: COMPILED_RUNTIME_FORMAT,
    engine: 'opencode',
    project_id: input.projectId,
    ref: input.ref,
    source_sha: input.sourceSha,
    agent_config: agentConfig,
    agent_config_etag: etag(agentConfig),
    opencode_config_dir: input.opencodeConfigDir ?? null,
    opencode_config_archive_sha256: opencodeConfigArchive
      ? createHash('sha256').update(opencodeConfigArchive).digest('hex')
      : null,
    opencode_config_archive_bytes: opencodeConfigArchive?.byteLength ?? null,
  };
  const source = runtimeSource(manifest, input.agentBundle, opencodeConfigArchiveBase64);
  return {
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    size: Buffer.byteLength(source),
    manifest,
  };
}
