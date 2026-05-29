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
 * The project workspace is NOT baked in — the daemon git-clones it at boot
 * via `KORTIX_PROJECT_AUTO_CLONE`. That keeps the image identity decoupled
 * from project source code, so a code change never invalidates a snapshot
 * and most projects share a single global default image.
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
 * Hardcoded "platform default" Dockerfile. Used when a session boots from
 * Kortix's default template — no user customization, just Ubuntu plus the
 * Kortix runtime layer on top. The workspace gets cloned at boot.
 *
 * This is fed into `buildLayeredDockerfile` like any other user Dockerfile.
 * Exposed so the snapshot identity hash treats it as a stable input.
 */
export const PLATFORM_DEFAULT_USER_DOCKERFILE = [
  '# syntax=docker/dockerfile:1.7',
  '# Kortix platform default sandbox base.',
  '# Sessions clone the project workspace at boot — nothing project-specific',
  '# is baked in here. Customize via `[[sandboxes]]` in kortix.toml.',
  'FROM ubuntu:24.04',
  '',
  'WORKDIR /workspace',
  '',
].join('\n') + '\n';

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
  /**
   * Path the snapshot builder will reference for the gzipped `kortix` CLI
   * binary. This is the admin CLI every in-sandbox agent reaches for
   * (`kortix cr open`, `secrets`, `sessions`, …); it lands on PATH as
   * `/usr/local/bin/kortix`, pre-authenticated via the injected
   * KORTIX_CLI_TOKEN. Always provided by the production builder.
   */
  cliBinaryPath: string;
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
    cliBinaryPath,
    entrypointScriptPath,
    agentCliPath,
    executorSdkPath,
  } = opts;
  const trimmed = normalizeUserDockerfileForSnapshot(userDockerfile).trimEnd();

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
    // bun runtime for the agent CLIs (slack, kchannel, …).
    'RUN curl -fsSL https://bun.com/install | bash \\',
    '    && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \\',
    '    && bun --version',
    '',
    `RUN npm install -g --no-audit --no-fund "agent-browser@${agentBrowserVersion}" \\`,
    '    && agent-browser --version',
    'ENV AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage',
    '',
    `COPY ${agentBinaryPath} /tmp/kortix-agent.gz`,
    `COPY ${cliBinaryPath} /tmp/kortix.gz`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    // Keep the repo-relative layout so CLIs can import shared packages.
    `COPY ${agentCliPath}/ /opt/kortix/apps/sandbox/agent-cli/`,
    `COPY ${executorSdkPath}/ /opt/kortix/packages/executor-sdk/`,
    'RUN gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\',
    '    && gunzip -c /tmp/kortix.gz > /usr/local/bin/kortix \\',
    '    && rm /tmp/kortix-agent.gz /tmp/kortix.gz \\',
    '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/agent-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli \\',
    // Fail the build loudly if the CLI didn't land — every sandbox must ship it.
    '    && kortix --version',
    '',
    // The daemon clones the project workspace at boot using KORTIX_PROJECT_AUTO_CLONE
    // — nothing project-specific is baked into the image. /workspace is created
    // empty here; the daemon's materializeRepo path fills it.
    'ENV KORTIX_WORKSPACE=/workspace',
    'RUN mkdir -p /workspace /opt/kortix/home /ephemeral/kortix-master/opencode',
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ].join('\n');

  return `${trimmed}\n${kortixLayer}`;
}

export function normalizeUserDockerfileForSnapshot(dockerfile: string): string {
  // The legacy starter Dockerfile installed baseline tools that the injected
  // Kortix layer installs again. Strip that exact starter block so existing
  // user Dockerfiles still build cleanly.
  const starterBlock =
    /# Bring in baseline tooling\. The Kortix layer on top also installs\n# git\/curl\/ca-certificates\/nodejs\/npm, but having them in your base\n# makes interactive sessions snappier\.\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends \\\n        ca-certificates \\\n        curl \\\n        git \\\n        build-essential \\\n    && rm -rf \/var\/lib\/apt\/lists\/\*\n\n?/;
  return dockerfile.replace(starterBlock, '');
}

/**
 * A sandbox template defines one bootable image. Projects can declare multiple
 * via `[[sandboxes]]` in kortix.toml; sessions pick one by slug. The platform
 * default template is always available without any config.
 */
export interface SandboxTemplate {
  /** Stable identifier the session creator references. Unique per project. */
  slug: string;
  /** Display label shown in the dashboard picker. Optional. */
  name?: string;
  /**
   * Repo-relative path to a Dockerfile. The builder reads its bytes and layers
   * the Kortix runtime on top. Mutually exclusive with `image`.
   */
  dockerfile?: string;
  /**
   * Public Docker image reference (e.g. `python:3.12-slim`). The builder
   * generates a tiny `FROM <image>` shim and layers the Kortix runtime on top.
   * Mutually exclusive with `dockerfile`.
   */
  image?: string;
  /** Hardware spec (cpu/memory/disk). GPUs are intentionally not supported. */
  spec: SandboxSpec;
  /**
   * True iff this is the platform default (no user customization). Never
   * declared in kortix.toml — the platform synthesizes one of these.
   */
  isDefault?: boolean;
}

/** Reserved slug for the platform-provided default template. */
export const DEFAULT_SANDBOX_SLUG = 'default';

/**
 * Build the canonical platform default template. Always available, identity
 * derived purely from the platform runtime fingerprint — every project on the
 * same Kortix release shares one image.
 */
export function buildDefaultSandboxTemplate(spec: SandboxSpec = {}): SandboxTemplate {
  return {
    slug: DEFAULT_SANDBOX_SLUG,
    name: 'Default',
    spec,
    isDefault: true,
  };
}

/**
 * Hardware spec for the sandbox, read from `[[sandboxes]]` entries in
 * kortix.toml. Fields map onto Daytona's snapshot `Resources` (vCPU cores,
 * memory & disk in GiB). GPU is intentionally omitted. Every field is
 * optional; an unset field uses the platform default.
 */
export interface SandboxSpec {
  /** vCPU cores. */
  cpu?: number;
  /** Memory in GiB. */
  memory?: number;
  /** Disk in GiB. */
  disk?: number;
}

/**
 * Defensive bounds for each spec field. A value below `min` is dropped and
 * the platform default is used; a value above `max` is clamped to `max`.
 */
export const SANDBOX_SPEC_LIMITS = {
  cpu: { min: 1, max: 32 },
  memory: { min: 1, max: 128 }, // GiB
  disk: { min: 1, max: 500 }, // GiB
} as const;

/** True when no spec field is set — i.e. boot at the platform default size. */
export function sandboxSpecIsEmpty(spec: SandboxSpec): boolean {
  return spec.cpu === undefined && spec.memory === undefined && spec.disk === undefined;
}

function pickResource(value: unknown, bounds: { min: number; max: number }): number | undefined {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  n = Math.round(n);
  if (n < bounds.min) return undefined;
  if (n > bounds.max) n = bounds.max;
  return n;
}

function extractSpecFromRow(row: Record<string, unknown>): SandboxSpec {
  const spec: SandboxSpec = {};
  const cpu = pickResource(row.cpu ?? row.cpus, SANDBOX_SPEC_LIMITS.cpu);
  const memory = pickResource(row.memory ?? row.memory_gb ?? row.mem, SANDBOX_SPEC_LIMITS.memory);
  const disk = pickResource(row.disk ?? row.disk_gb, SANDBOX_SPEC_LIMITS.disk);
  if (cpu !== undefined) spec.cpu = cpu;
  if (memory !== undefined) spec.memory = memory;
  if (disk !== undefined) spec.disk = disk;
  return spec;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Parse `[[sandboxes]]` from a parsed manifest. Returns the user-declared
 * templates in declaration order. The platform default is NOT included here;
 * callers always add it themselves so it can't be shadowed by a misnamed slug.
 *
 * The slug `default` is reserved for the platform-shared template — any
 * `[[sandboxes]]` entry that tries to claim it is dropped with a warning.
 *
 * Malformed entries are skipped (logged) so a broken table can't take down
 * session boot for the rest of the project.
 */
export function extractSandboxTemplates(
  manifestRaw: Record<string, unknown> | null | undefined,
): SandboxTemplate[] {
  if (!manifestRaw) return [];
  const out: SandboxTemplate[] = [];
  const seenSlugs = new Set<string>();

  // [[sandboxes]] = array of tables
  const arr = manifestRaw.sandboxes;
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const tpl = parseSandboxTemplate(row);
      if (!tpl) continue;
      if (tpl.slug === DEFAULT_SANDBOX_SLUG) {
        console.warn(`[sandbox-templates] slug "default" is reserved — skipping entry`);
        continue;
      }
      if (seenSlugs.has(tpl.slug)) {
        console.warn(`[sandbox-templates] duplicate slug "${tpl.slug}" — keeping first`);
        continue;
      }
      seenSlugs.add(tpl.slug);
      out.push(tpl);
    }
  }

  return out;
}

function parseSandboxTemplate(row: Record<string, unknown>): SandboxTemplate | null {
  const slugRaw = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slugRaw || !SLUG_RE.test(slugRaw)) {
    console.warn(`[sandbox-templates] entry missing or invalid slug, skipped:`, row);
    return null;
  }
  const dockerfile = typeof row.dockerfile === 'string' ? row.dockerfile.trim() : '';
  const image = typeof row.image === 'string' ? row.image.trim() : '';
  if (dockerfile && image) {
    console.warn(`[sandbox-templates] "${slugRaw}" sets both dockerfile and image — keeping dockerfile`);
  }
  const spec = extractSpecFromRow(row);
  const name = typeof row.name === 'string' ? row.name.trim() : undefined;
  const sanitizedDockerfile = dockerfile ? sanitizeRelPath(dockerfile) : '';
  return {
    slug: slugRaw,
    name: name || undefined,
    dockerfile: sanitizedDockerfile || undefined,
    image: !sanitizedDockerfile && image ? image : undefined,
    spec,
  };
}

function sanitizeRelPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return '';
  if (trimmed.split('/').includes('..')) return '';
  return trimmed;
}
