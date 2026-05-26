/**
 * Compose the layered Dockerfile that becomes a session sandbox image.
 *
 * The user's Dockerfile defines whatever workspace they want (language
 * toolchains, system packages, seed data). We append a final stage that
 * makes the result *connectable* by the Kortix dashboard:
 *
 *   1. apt-get install ca-certificates curl git nodejs npm
 *   2. npm install -g opencode-ai@<pinned-version>
 *   3. COPY the kortix-agent + kortix-entrypoint binaries to /usr/local/bin
 *   4. ENV KORTIX_WORKSPACE=/workspace, WORKDIR /workspace, EXPOSE 8000
 *   5. ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
 *
 * Steps 1-2 require apt (Debian/Ubuntu family base). Step 5 means the
 * user's ENTRYPOINT is always overridden — see docs/dockerfile.mdx for
 * the user-facing constraint list.
 */

/**
 * Default pinned `agent-browser` (Vercel agent-browser) CLI version baked into
 * the layer when the caller doesn't pin one explicitly. The builder may pass an
 * override via `agentBrowserVersion` to centralize the pin (and fold it into the
 * snapshot fingerprint); this fallback keeps the layer self-contained.
 */
const DEFAULT_AGENT_BROWSER_VERSION = '0.27.0';

/**
 * Playwright version we use *only* as a cross-arch source for a headless
 * Chromium binary. Chrome for Testing (what `agent-browser install` downloads)
 * ships no Linux arm64 build, so on arm64 nodes / Apple-Silicon dev that path
 * hard-fails. Playwright publishes prebuilt Chromium for both linux-x64 and
 * linux-arm64 and its `--with-deps` installs the OS libraries on Debian/Ubuntu,
 * so we bake that binary and point agent-browser at it via
 * `AGENT_BROWSER_EXECUTABLE_PATH`.
 */
const PLAYWRIGHT_VERSION = '1.60.0';

export interface BuildLayeredDockerfileOpts {
  /** Literal contents of the user's project Dockerfile. */
  userDockerfile: string;
  /** Pinned opencode CLI version (matches platform-wide `OPENCODE_VERSION`). */
  opencodeVersion: string;
  /**
   * Pinned `agent-browser` CLI version. Optional — defaults to
   * `DEFAULT_AGENT_BROWSER_VERSION`. The builder passes the platform-wide
   * `AGENT_BROWSER_VERSION` so the pin is centralized and fingerprinted.
   */
  agentBrowserVersion?: string;
  /** Path the snapshot builder will reference for the gzipped kortix-agent binary. */
  agentBinaryPath: string;
  /** Path the snapshot builder will reference for the entrypoint script. */
  entrypointScriptPath: string;
  /**
   * Path the snapshot builder will reference for the agent-cli source tree
   * (apps/sandbox/agent-cli). The layer COPYs it into
   * /opt/kortix/apps/sandbox/agent-cli
   * and runs install-shims.sh to wire each *.ts (excluding lib/) as a
   * /usr/local/bin/<name> shim — that's how `slack`, `kchannel`, … land on
   * PATH for the agent to invoke from inside the sandbox.
   */
  agentCliPath: string;
  /**
   * Path the snapshot builder will reference for packages/executor-sdk.
   * The agent CLI imports it via the same repo-relative path in dev and in
   * real snapshots.
   */
  executorSdkPath: string;
  /** Gzipped tarball containing the baked project checkout, including .git. */
  workspaceArchivePath: string;
}

export function buildLayeredDockerfile(opts: BuildLayeredDockerfileOpts): string {
  const {
    userDockerfile,
    opencodeVersion,
    agentBrowserVersion = DEFAULT_AGENT_BROWSER_VERSION,
    agentBinaryPath,
    entrypointScriptPath,
    agentCliPath,
    executorSdkPath,
    workspaceArchivePath,
  } = opts;
  const trimmed = userDockerfile.trimEnd();

  const kortixLayer = [
    '',
    '# ─── Kortix runtime layer (auto-injected) ──────────────────────────',
    '# Everything below is added by the Kortix snapshot builder. Do not',
    "# edit by hand — your project Dockerfile above is preserved verbatim.",
    '',
    'USER root',
    // tmux: lets the agent run long-running processes (dev servers for preview)
    // in a detached session that survives the agent\'s bash tool call.
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git gzip nodejs npm unzip tmux \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    `RUN npm install -g --no-audit --no-fund "opencode-ai@${opencodeVersion}" \\`,
    '    && command -v opencode \\',
    '    && opencode --version',
    '',
    // bun runtime for the agent CLIs (slack, kchannel, …). The user\'s base
    // image likely doesn\'t have it, so install via the official script and
    // surface on PATH for all users.
    'RUN curl -fsSL https://bun.com/install | bash \\',
    '    && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \\',
    '    && bun --version',
    '',
    // Install the `kortix` CLI for in-sandbox use. Curls the platform's
    // install script which downloads the right binary for this image's
    // arch from GitHub Releases. Failsoft: if the install script can't
    // resolve a release (e.g. first boot before any `cli-v*` tag is
    // pushed), we still build the snapshot — the sandbox just won't
    // have `kortix` on PATH until a later snapshot build.
    'RUN curl -fsSL https://kortix.com/install | bash \\',
    '    || echo "kortix CLI not yet available — sandbox will boot without it"',
    '',
    // agent-browser (Vercel agent-browser): fast browser-automation CLI for
    // the agent — drives Chrome/Chromium over CDP from accessibility-tree
    // snapshots. Install the Rust CLI globally, then bake a headless Chromium.
    // We source Chromium from Playwright (not `agent-browser install`, whose
    // Chrome-for-Testing has no linux-arm64 build) since Playwright ships both
    // linux-x64 and linux-arm64 builds and installs the OS libs via
    // `--with-deps`. agent-browser is pointed at it through the ENV below; the
    // agent loads usage via `agent-browser skills get core` at runtime.
    `RUN npm install -g --no-audit --no-fund "agent-browser@${agentBrowserVersion}" \\`,
    '    && apt-get update \\',
    `    && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \\`,
    '    && rm -rf /var/lib/apt/lists/* \\',
    "    && ln -sf \"$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)\" /usr/local/bin/chromium \\",
    '    && /usr/local/bin/chromium --version \\',
    '    && agent-browser --version',
    // --no-sandbox: the sandbox already runs as root inside an isolated VM, and
    // Chromium refuses its own sandbox as root. Point agent-browser at the
    // Playwright Chromium baked above.
    'ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \\',
    '    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \\',
    '    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage',
    '',
    `COPY ${agentBinaryPath} /tmp/kortix-agent.gz`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    // Keep the repo-relative layout so CLIs can import shared packages.
    `COPY ${agentCliPath}/ /opt/kortix/apps/sandbox/agent-cli/`,
    `COPY ${executorSdkPath}/ /opt/kortix/packages/executor-sdk/`,
    `COPY ${workspaceArchivePath} /tmp/kortix-workspace.tar.gz`,
    'RUN gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\',
    '    && rm /tmp/kortix-agent.gz \\',
    '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/agent-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli',
    '',
    // Pre-seed /workspace with the project checkout, including .git. This is
    // the session hot path: boot should create a local session branch from the
    // baked default-branch checkout instead of cloning/fetching the repo again.
    'ENV KORTIX_WORKSPACE=/workspace',
    'RUN mkdir -p /workspace \\',
    '    && tar -xzf /tmp/kortix-workspace.tar.gz -C /workspace \\',
    '    && rm /tmp/kortix-workspace.tar.gz \\',
    '    && test -d /workspace/.git \\',
    '    && chmod -R a+rwX /workspace',
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ].join('\n');

  return `${trimmed}\n${kortixLayer}`;
}

/**
 * Read `[sandbox] dockerfile` + `[sandbox] context` from a parsed
 * manifest, with the same defaults the rest of the platform applies.
 * Defensive against malformed shapes — falls back rather than throwing
 * so a broken `[sandbox]` table doesn't take down a session boot.
 */
export interface SandboxPaths {
  dockerfile: string;
  context: string;
}

export const DEFAULT_SANDBOX_PATHS: SandboxPaths = {
  dockerfile: '.kortix/Dockerfile',
  context: '.',
};

export function extractSandboxPaths(manifestRaw: Record<string, unknown> | null | undefined): SandboxPaths {
  if (!manifestRaw) return { ...DEFAULT_SANDBOX_PATHS };
  const sandbox = manifestRaw.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    return { ...DEFAULT_SANDBOX_PATHS };
  }
  const row = sandbox as Record<string, unknown>;
  return {
    dockerfile: pickRelPath(row.dockerfile, DEFAULT_SANDBOX_PATHS.dockerfile),
    context: pickRelPath(row.context ?? row.context_dir, DEFAULT_SANDBOX_PATHS.context),
  };
}

function pickRelPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/')) return fallback;
  if (trimmed.split('/').includes('..')) return fallback;
  return trimmed;
}

/**
 * Hardware spec for the sandbox, read from `[sandbox]` in kortix.toml.
 * Fields map one-to-one onto Daytona's snapshot `Resources` (vCPU cores,
 * memory & disk in GiB, GPU units). Every field is optional; an unset
 * field uses the provider's default size.
 *
 * The spec is baked into the per-project snapshot at build time — Daytona
 * inherits a sandbox's resources from its snapshot and has no way to
 * override them per-sandbox — so it's also part of the snapshot identity
 * hash (see snapshots/hash.ts): change the spec, rebuild the snapshot.
 */
export interface SandboxSpec {
  /** vCPU cores. */
  cpu?: number;
  /** Memory in GiB. */
  memory?: number;
  /** Disk in GiB. */
  disk?: number;
  /** GPU units. */
  gpu?: number;
}

/**
 * Defensive bounds for each spec field. A value below `min` (e.g. `0`,
 * a negative, or a typo) is dropped and the provider default is used; a
 * value above `max` is clamped to `max` rather than rejected, so an
 * over-eager request still boots — just capped. Tune the ceilings to
 * match what the runtime provider / plan actually allows.
 */
export const SANDBOX_SPEC_LIMITS = {
  cpu: { min: 1, max: 32 },
  memory: { min: 1, max: 128 }, // GiB
  disk: { min: 1, max: 500 }, // GiB
  gpu: { min: 1, max: 8 },
} as const;

export function extractSandboxSpec(
  manifestRaw: Record<string, unknown> | null | undefined,
): SandboxSpec {
  if (!manifestRaw) return {};
  const sandbox = manifestRaw.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return {};
  const row = sandbox as Record<string, unknown>;
  const spec: SandboxSpec = {};
  // Accept a couple of friendly aliases — `cpus`, `memory_gb`/`mem`,
  // `disk_gb` — so the table reads naturally however it's written.
  const cpu = pickResource(row.cpu ?? row.cpus, SANDBOX_SPEC_LIMITS.cpu);
  const memory = pickResource(row.memory ?? row.memory_gb ?? row.mem, SANDBOX_SPEC_LIMITS.memory);
  const disk = pickResource(row.disk ?? row.disk_gb, SANDBOX_SPEC_LIMITS.disk);
  const gpu = pickResource(row.gpu, SANDBOX_SPEC_LIMITS.gpu);
  if (cpu !== undefined) spec.cpu = cpu;
  if (memory !== undefined) spec.memory = memory;
  if (disk !== undefined) spec.disk = disk;
  if (gpu !== undefined) spec.gpu = gpu;
  return spec;
}

/** True when no spec field is set — i.e. boot at the provider default size. */
export function sandboxSpecIsEmpty(spec: SandboxSpec): boolean {
  return (
    spec.cpu === undefined &&
    spec.memory === undefined &&
    spec.disk === undefined &&
    spec.gpu === undefined
  );
}

function pickResource(value: unknown, bounds: { min: number; max: number }): number | undefined {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  n = Math.round(n);
  if (n < bounds.min) return undefined; // 0 / negative / typo → provider default
  if (n > bounds.max) n = bounds.max; // clamp absurd values rather than reject
  return n;
}
