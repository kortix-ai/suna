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

export interface BuildLayeredDockerfileOpts {
  /** Literal contents of the user's project Dockerfile. */
  userDockerfile: string;
  /** Pinned opencode CLI version (matches platform-wide `OPENCODE_VERSION`). */
  opencodeVersion: string;
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
