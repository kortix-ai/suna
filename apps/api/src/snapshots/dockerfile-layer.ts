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
    'RUN gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\',
    '    && rm /tmp/kortix-agent.gz \\',
    '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/agent-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli',
    '',
    // Pre-seed /workspace with a sentinel file. Daytona\'s runtime appears
    // to clean up *empty* /workspace directories shortly after the
    // container starts (likely overlayfs init), leaving the daemon\'s CWD
    // pointing at a deleted inode and every subsequent fs op silently
    // failing. The working default snapshot survives this because its
    // /workspace is non-empty at image build time (XDG dirs, .bun, etc.);
    // we replicate the property with a deliberate marker.
    'ENV KORTIX_WORKSPACE=/workspace',
    'RUN mkdir -p /workspace \\',
    '    && echo "kortix-snapshot" > /workspace/.kortix-workspace-marker \\',
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
