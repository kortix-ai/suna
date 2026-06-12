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

const DOCKERFILE_SYNTAX_IMAGE =
  process.env.KORTIX_DOCKERFILE_SYNTAX_IMAGE?.trim() || 'docker/dockerfile:1.7';
const PLATFORM_DEFAULT_BASE_IMAGE =
  process.env.KORTIX_PLATFORM_DEFAULT_BASE_IMAGE?.trim() || 'ubuntu:24.04';

/**
 * Hardcoded "platform default" Dockerfile. Used when a session boots from
 * Kortix's default template — no user customization, just Ubuntu plus the
 * Kortix runtime layer on top. The workspace gets cloned at boot.
 *
 * This is fed into `buildLayeredDockerfile` like any other user Dockerfile.
 * Exposed so the snapshot identity hash treats it as a stable input.
 */
export const PLATFORM_DEFAULT_USER_DOCKERFILE = [
  `# syntax=${DOCKERFILE_SYNTAX_IMAGE}`,
  '# Kortix platform default sandbox base.',
  '# Sessions clone the project workspace at boot — nothing project-specific',
  '# is baked in here. Customize via `[[sandbox.templates]]` in kortix.toml.',
  `FROM ${PLATFORM_DEFAULT_BASE_IMAGE}`,
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
    // iproute2 (`ip`) + iputils-arping are REQUIRED on Platinum: a warm-pool
    // clone is a memory-restored VM that keeps its snapshot-baked IP until the
    // host's reconfigure_net runs `ip addr flush/add` + a gratuitous `arping`
    // inside the guest. Without these the IP never changes → the guest stays on
    // the baked IP while the edge routes to the allocated IP → every request
    // 502s. (Harmless on Daytona, which doesn't memory-restore.)
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git gzip nodejs npm unzip tmux iproute2 iputils-arping \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    `RUN npm install -g --no-audit --no-fund "opencode-ai@${opencodeVersion}" \\`,
    '    && command -v opencode \\',
    '    && opencode --version',
    '',
    // Bake OpenCode's "one time database migration" at BUILD time. The first time
    // opencode serves, it migrates its sqlite schema — logged as "Performing one
    // time database migration (may take a few minutes)" — before it answers any
    // request. On a fresh VM that runs on the session hot path, adding ~15-35s
    // before opencode replies to /session; on a warm-pool claim that window is
    // exactly what surfaces as the FE's "sandbox not ready" 503s. opencode's db
    // lives in a BAKED path (XDG_DATA_HOME=/opt/kortix/home/.local/share), so we
    // run opencode here once to complete the migration and bake the migrated db
    // into the image layer. Every boot afterwards — cold or warm-pool restore —
    // then finds an already-migrated db and answers in ~2-3s. Env MUST match the
    // daemon's spawn (apps/kortix-sandbox-agent-server/src/opencode.ts). Best
    // effort: if opencode can't serve at build time it just falls back to the
    // old boot-time migration — never fail the whole image build over a warm-up.
    'RUN set +e; \\',
    '    export HOME=/opt/kortix/home \\',
    '        XDG_DATA_HOME=/opt/kortix/home/.local/share \\',
    '        XDG_CONFIG_HOME=/opt/kortix/home/.config \\',
    '        XDG_CACHE_HOME=/opt/kortix/home/.cache; \\',
    '    mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"; \\',
    '    opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/oc-bake.log 2>&1 & oc_pid=$!; \\',
    '    for i in $(seq 1 180); do \\',
    '        curl -s -o /dev/null -m 2 http://127.0.0.1:4096/ && break; \\',
    '        kill -0 "$oc_pid" 2>/dev/null || break; \\',
    '        sleep 1; \\',
    '    done; \\',
    '    sleep 3; \\',
    '    kill "$oc_pid" 2>/dev/null; wait "$oc_pid" 2>/dev/null; \\',
    '    echo "=== migration-bake: opencode data dir ==="; ls -laR "$XDG_DATA_HOME/opencode" 2>/dev/null | head -40; \\',
    '    echo "=== migration-bake: opencode log tail ==="; tail -25 /tmp/oc-bake.log; \\',
    '    rm -f /tmp/oc-bake.log; true',
    '',
    // bun runtime for the agent CLIs (slack, kchannel, …).
    'RUN curl -fsSL https://bun.com/install | bash \\',
    '    && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \\',
    '    && bun --version',
    '',
    // Pre-install the OpenCode tool dependencies once, at image-build time, into a
    // stable baked location. The tools in .kortix/opencode/tools/ (web_search,
    // image_search, scrape_webpage) import these, and OpenCode runs `bun install`
    // in the cloned config dir at boot — but node_modules/bun.lock are gitignored,
    // so that boot install would otherwise RE-RESOLVE the `^` ranges over the
    // network (a 1.5–6s — sometimes minutes — stall on the session hot path). The
    // daemon's ensureOpencodeConfigDeps() links this baked node_modules + bun.lock
    // into the resolved config dir before opencode starts, making the boot install
    // a no-op. The same step also warms Bun's cache at the runtime HOME
    // (HOME=/opt/kortix/home). Keep deps in sync with
    // packages/starter/templates/base/.kortix/opencode/package.json — and bump
    // RUNTIME_LAYER_VERSION in templates.ts when they change (the rendered
    // Dockerfile is not itself part of the snapshot fingerprint).
    'RUN mkdir -p /opt/kortix/home/.bun/install/cache /opt/kortix/opencode-config-deps \\',
    '    && cd /opt/kortix/opencode-config-deps \\',
    `    && printf '{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@tavily/core":"^0.7.3","replicate":"^1.4.0"}}' > package.json \\`,
    '    && HOME=/opt/kortix/home BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache bun install',
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
 * via `[[sandbox.templates]]` in kortix.toml; sessions pick one by slug. The platform
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
 * Hardware spec for the sandbox, read from `[[sandbox.templates]]` entries in
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
 * Parse `[[sandbox.templates]]` from a parsed manifest. Returns the
 * user-declared templates in declaration order. The platform default is NOT
 * included here; callers always add it themselves so it can't be shadowed by
 * a misnamed slug.
 *
 * The slug `default` is reserved for the platform-shared template — any
 * `[[sandbox.templates]]` entry that tries to claim it is dropped with a warning.
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

  // [[sandbox.templates]] = array of tables (parses to sandbox.templates).
  const sandbox = manifestRaw.sandbox;
  const nested =
    sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox)
      ? (sandbox as Record<string, unknown>).templates
      : undefined;
  // Migration safety net: the pre-rename `[[sandboxes]]` form still parses at
  // boot so an un-migrated project on main doesn't lose its templates. The
  // validator (ship / CR-merge gate) is what enforces the new name.
  const arr = Array.isArray(nested) ? nested : manifestRaw.sandboxes;
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

/**
 * Read `[sandbox] default` — the project-wide default template slug that every
 * session boots when the caller doesn't pass an explicit `sandbox_slug`.
 * Returns null when unset (→ the platform default image). The reserved
 * "default" is treated as "no override" since it IS the platform default.
 */
export function extractSandboxDefault(
  manifestRaw: Record<string, unknown> | null | undefined,
): string | null {
  const sandbox = manifestRaw?.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return null;
  const raw = (sandbox as Record<string, unknown>).default;
  const slug = typeof raw === 'string' ? raw.trim() : '';
  if (!slug || slug === DEFAULT_SANDBOX_SLUG || !SLUG_RE.test(slug)) return null;
  return slug;
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
