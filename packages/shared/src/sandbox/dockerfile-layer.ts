/**
 * Compose the layered Dockerfile that becomes a project agent's sandbox image.
 *
 * The user's Dockerfile defines whatever workspace they want (language
 * toolchains, system packages, seed data). We append the Kortix runtime layer:
 *
 *   1. the Kortix defaults' setup (`kortixDefaultsSetup`, defaults.ts)
 *   2. the project-agent workstation (`kortixWorkstationTooling` below)
 *   3. the Kortix defaults' staged tail (`kortixDefaultsTail`, defaults.ts)
 *
 * The defaults are the same in every Kortix sandbox image, My Kortix's
 * included; defaults.ts owns them. This file owns only what project agents add.
 *
 * The project workspace is NOT baked in — the daemon git-clones it at boot
 * via `KORTIX_PROJECT_AUTO_CLONE`. That keeps the image identity decoupled
 * from project source code, so a code change never invalidates a snapshot
 * and most projects share a single global default image.
 *
 * The layer requires apt (Debian/Ubuntu family base) and always overrides the
 * user's ENTRYPOINT.
 */

import {
  AGENT_BROWSER_VERSION as DEFAULT_AGENT_BROWSER_VERSION,
  ANYDOC_VERSION,
  PLAYWRIGHT_VERSION,
  PYTHON_PACKAGE_FLOOR,
  PYTHON_PACKAGE_FLOOR_IMPORTS,
} from '../runtime-versions';
import { SANDBOX_DESKTOP_INSTALL_COMMAND } from './desktop';
import {
  type KortixArtifactLayerOpts,
  SANDBOX_BASE_IMAGE,
  kortixDefaultsSetup,
  kortixDefaultsTail,
} from './defaults';

export {
  KORTIX_AGENT_ENV_FILE,
  KORTIX_SHELL_PROFILE_PATH,
  KORTIX_USER_PATH_DIRS,
  PI_AGENT_DIR,
  SANDBOX_BASE_IMAGE,
  kortixDefaultsSetup,
  kortixDefaultsTail,
  kortixShellProfileRun,
  kortixShellProfileScript,
  piSystemPackageLines,
  piSystemPackageWarmLines,
  type KortixArtifactLayerOpts,
} from './defaults';

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
  '# is baked in here. Customize via `sandbox.templates` in kortix.yaml.',
  `FROM ${SANDBOX_BASE_IMAGE}`,
  '',
  'WORKDIR /workspace',
  '',
].join('\n') + '\n';

/**
 * Inputs for the network half of the layer — everything that installs into
 * the image from the NETWORK (apt, pip, npm, bun, Playwright). It renders
 * against an empty build context.
 */
export interface KortixToolchainLayerOpts {
  /**
   * Pinned `agent-browser` CLI version. Optional — defaults to
   * `DEFAULT_AGENT_BROWSER_VERSION`. The builder passes the platform-wide
   * `AGENT_BROWSER_VERSION` so the pin is centralized and fingerprinted.
   */
  agentBrowserVersion?: string;
  /**
   * kortix.yaml `container_runtime: true`. The provider bakes the guest
   * kernel's full module tree (Platinum `kernel_modules: container`); the guest
   * kernel loads bridge/overlay/netfilter on demand through /sbin/modprobe, so
   * the image needs kmod. The marker env makes the entrypoint start dockerd at
   * boot. Unset renders the layer byte-identical to before.
   */
  containerRuntime?: boolean;
}

export interface BuildLayeredDockerfileOpts
  extends KortixToolchainLayerOpts,
    KortixArtifactLayerOpts {
  /** Literal contents of the user's project Dockerfile. */
  userDockerfile: string;
}

/**
 * What a project agent's computer adds to the Kortix defaults: the document
 * and build tools the starter skills drive, the session desktop, the Python
 * package floor, Chromium with agent-browser, and anydoc. Runs after
 * `kortixDefaultsSetup` (it needs the `kortix` user, uv and pnpm) and ends as
 * `USER kortix` with a trailing newline.
 */
export function kortixWorkstationTooling(opts: KortixToolchainLayerOpts): string {
  const {
    agentBrowserVersion = DEFAULT_AGENT_BROWSER_VERSION,
    containerRuntime,
  } = opts;

  return [
    '# ─── Project-agent workstation (dockerfile-layer.ts) ───',
    'USER root',
    // Office, PDF, OCR, and LaTeX tools support the starter marketplace skills.
    // Baked into every layered image so custom sandbox Dockerfiles get the
    // same tool floor as the platform default image.
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        build-essential ffmpeg fonts-dejavu fonts-liberation fonts-noto fonts-noto-cjk \\',
    '        latexmk libreoffice pandoc pkg-config poppler-utils qpdf tesseract-ocr \\',
    '        texlive-bibtex-extra texlive-fonts-recommended texlive-latex-base \\',
    '        texlive-latex-extra texlive-latex-recommended \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    // The session desktop (Xvfb + XFCE + voxl on :6901). See desktop.ts.
    `RUN ${SANDBOX_DESKTOP_INSTALL_COMMAND}`,
    '',
    'RUN mkdir -p /opt/pw-browsers && chown kortix:kortix /opt/pw-browsers',
    ...(containerRuntime
      ? [
          'RUN apt-get update && apt-get install -y --no-install-recommends kmod \\',
          '    && rm -rf /var/lib/apt/lists/* \\',
          '    && (getent group docker >/dev/null || groupadd --system docker) \\',
          '    && usermod -aG docker kortix',
          'ENV KORTIX_CONTAINER_RUNTIME=1',
        ]
      : []),
    'USER kortix',
    '',
    // The Python package floor: everything the starter skills import, baked
    // into the managed interpreter so bare `python3` works with zero runtime
    // resolution. `uv run --with` re-downloads wheels from PyPI on first use in
    // EVERY fresh sandbox — on the session hot path, network-dependent — so the
    // floor exists precisely to keep skill scripts off that path; `uv run
    // --with` remains the documented escape hatch for packages OUTSIDE the
    // floor only. `--break-system-packages` overrides uv's externally-managed
    // marker on the interpreter it just installed — this is OUR frozen
    // build-time interpreter, not a distro Python; nothing upgrades it after
    // this layer. python-playwright is pinned to the SAME version as the Node
    // playwright that bakes Chromium below, so both resolve the identical
    // browser revision under PLAYWRIGHT_BROWSERS_PATH.
    // The install targets the managed interpreter by EXPLICIT PATH, never by
    // discovery: `--system` skips uv-managed interpreters by design, and the
    // apt floor above drags in Ubuntu's distro python3 via LibreOffice — so
    // `--system` resolved /usr/bin/python3, where `kortix` cannot write, and
    // the v39 bake failed on every provider (dev, 2026-08-03). The local-repro
    // gap: a test container without the apt floor has no distro python, so
    // `--system` happens to fall back to the managed shim and "passes".
    // The import check is a single-line `python3 -c` on purpose: E2B's
    // Dockerfile parser reads a heredoc body's first line as an instruction
    // and aborts the build.
    'RUN uv pip install --python /home/kortix/.local/bin/python3 --break-system-packages \\',
    ...Object.entries(PYTHON_PACKAGE_FLOOR).map(
      ([pkg, version]) => `        "${pkg}==${version}" \\`,
    ),
    `    && python3 -c 'import importlib; [importlib.import_module(m) for m in ${JSON.stringify(
      Object.values(PYTHON_PACKAGE_FLOOR_IMPORTS).sort(),
    )}]; print("python package floor OK")'`,
    '',
    // agent-browser (Vercel) — the browser-automation CLI the agent-browser
    // skill drives. It must work OUT OF THE BOX with zero runtime download, so we
    // bake a real Chromium into the image and wire agent-browser to it TWO
    // independent ways:
    //   1. AGENT_BROWSER_EXECUTABLE_PATH → a stable user-local chromium
    //      symlink (the documented API; verified working on agent-browser 0.27.0).
    //   2. a symlink into agent-browser's OWN browser cache (chrome-linux64),
    //      which its auto-detect finds even if the env var is ever ignored again
    //      — it WAS, historically (vercel-labs/agent-browser#422). Belt + braces.
    // PLAYWRIGHT_BROWSERS_PATH is set BEFORE the install so Chromium lands in
    // /opt/pw-browsers (a stable system path the symlinks resolve against). The
    // build runs as the same `kortix` user as runtime, so the cache symlink lands
    // under its normal home. The build FAILS LOUDLY
    // (chromium --version + `agent-browser doctor`) if Chromium didn't wire up —
    // every sandbox ships a working browser; we never install one on the session
    // hot path.
    //
    // ── LAYER ORDER IS LOAD-BEARING — DO NOT MOVE THIS DOWN ───────────────────
    // This ~150MB Chromium download sits DIRECTLY on top of the deterministic
    // apt + pip floors and DELIBERATELY ABOVE everything below it: a
    // NON-DETERMINISTIC layer (an install that churns mtimes, a RUN text with a
    // fresh credential) must never sit above it. The providers'
    // build caches are CONTENT-ADDRESSED (Daytona especially — it has no
    // Docker-style instruction-text cache and no `swapAgent` fast path), so ANY
    // non-deterministic layer BUSTS the cache for everything chained BELOW it.
    //
    // The kortix-agent SOURCE feeds the snapshot fingerprint (see
    // AGENT_RUNTIME_ARTIFACTS in apps/api/src/snapshots/templates.ts), so any
    // agent-server code change mints a BRAND-NEW snapshot name → a full rebuild on
    // Daytona (no agent-swap). If Chromium sat below a non-deterministic layer (as it did
    // through v0.10.11), every such rebuild MISSED cache and re-downloaded ~150MB
    // from cdn.playwright.dev — overrunning the session-ready window and breaking
    // fresh-sandbox boots (the v0.10.11 "session never starts" incident). Keeping
    // Chromium on purely deterministic parents makes its content hash stable
    // across agent-source churn: it is fetched at most ONCE per pinned Playwright/
    // agent-browser version and cache-reused for every rebuild after. The retry
    // loop + 30-min timeout below are the SAFETY NET for that one cold fetch.
    'ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \\',
    '    AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium \\',
    '    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--test-type,--disable-infobars \\',
    // Playwright's browser download defaults to a 30s socket timeout
    // (NET_DEFAULT_TIMEOUT in playwright-core), which a ~150MB Chrome-for-Testing
    // fetch can miss under any network hiccup / contended CDN — observed live as
    // "Downloading Chrome for Testing ... timed out after 30000ms" failing the
    // whole bake. 30 minutes gives real headroom for the one cold-cache fetch
    // under contention (staging observed this stalling on slower Daytona egress);
    // the retry loop below is the second line of defense for a transient failure
    // within that window.
    '    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=1800000',
    `RUN pnpm add -g --allow-build=agent-browser "agent-browser@${agentBrowserVersion}" \\`,
    '    && agent-browser --version \\',
    // Retry the Chromium download a handful of times with backoff before giving
    // up — a transient CDN/network blip must not fail the whole image build. The
    // loop's own exit status is irrelevant either way: `test -n "$pw_chrome"`
    // below still hard-fails the build if every attempt came up empty, so a total
    // failure never ships a browser-less image.
    '    && for pw_try in 1 2 3 4 5; do \\',
    `        pnpm dlx playwright@${PLAYWRIGHT_VERSION} install --with-deps --no-shell chromium && break; \\`,
    '        echo "playwright chromium install attempt $pw_try failed, retrying..."; \\',
    '        sleep $((pw_try*10)); \\',
    '    done \\',
    '    && sudo rm -rf /var/lib/apt/lists/* \\',
    `    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \\`,
    '    && test -n "$pw_chrome" \\',
    '    && ln -sf "$pw_chrome" /home/kortix/.local/bin/chromium \\',
    '    && mkdir -p /home/kortix/.agent-browser/browsers \\',
    '    && ln -sf "$(dirname "$pw_chrome")" /home/kortix/.agent-browser/browsers/chrome-linux64 \\',
    // One browser on the machine: no separate headless shell (~260 MB). Its
    // path, where Playwright's headless launches look, is the same Chromium.
    // The markers stop a later `playwright install` from fetching it anyway.
    '    && pw_rev="${pw_chrome#/opt/pw-browsers/chromium-}" && pw_rev="${pw_rev%%/*}" \\',
    '    && pw_shell_dir="/opt/pw-browsers/chromium_headless_shell-${pw_rev}" \\',
    '    && case "$(uname -m)" in x86_64) pw_shell=chrome-headless-shell-linux64/chrome-headless-shell ;; *) pw_shell=chrome-linux/headless_shell ;; esac \\',
    '    && mkdir -p "$(dirname "${pw_shell_dir}/${pw_shell}")" \\',
    '    && ln -sf "$pw_chrome" "${pw_shell_dir}/${pw_shell}" \\',
    '    && touch "${pw_shell_dir}/INSTALLATION_COMPLETE" "${pw_shell_dir}/DEPENDENCIES_VALIDATED" \\',
    '    && test -x "${pw_shell_dir}/${pw_shell}" \\',
    '    && chromium --version \\',
    // Assert agent-browser RESOLVES the browser via its env-independent cache —
    // match the resolved path (deterministic), not the browser NAME (which is
    // "Chromium" on arm64 but "Google Chrome for Testing" on x64). The doctor
    // "Launch test" may itself fail under cross-arch QEMU emulation; we read the
    // detection line, not the launch verdict, so the gate is emulation-safe.
    "    && env -u AGENT_BROWSER_EXECUTABLE_PATH agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'",
    '',
    // anydoc (Firecrawl) — the document→Markdown converter the
    // convert-documents-to-markdown skill drives (Word/PowerPoint/Excel/ODF/
    // RTF/EPUB/CSV/PDF → GFM). Baked so it works with zero runtime download —
    // the upstream skill's `npx -y` would fetch from npm on the session hot
    // path. Pure napi prebuilt binaries via platform optionalDependencies; no
    // build scripts, so no --allow-build.
    `RUN pnpm add -g "@firecrawl/anydoc@${ANYDOC_VERSION}" \\`,
    '    && command -v anydoc \\',
    `    && test "$(anydoc --version)" = "${ANYDOC_VERSION}"`,
    '',
  ].join('\n') + '\n';
}

/**
 * The network half of a project agent's runtime layer: the Kortix defaults'
 * setup, then the workstation. Renders against an EMPTY build context — it
 * stages nothing — and ends with a trailing newline so it concatenates
 * directly onto `kortixArtifactLayer`.
 */
export function kortixToolchainLayer(opts: KortixToolchainLayerOpts): string {
  return [
    '',
    '# ─── Kortix runtime layer (auto-injected) ──────────────────────────',
    '# Everything below is added by the Kortix snapshot builder. Do not',
    "# edit by hand — your project Dockerfile above is preserved verbatim.",
    '',
  ].join('\n') + kortixDefaultsSetup() + kortixWorkstationTooling(opts);
}

/** The staged half of the runtime layer: the Kortix defaults' tail. */
export function kortixArtifactLayer(opts: KortixArtifactLayerOpts): string {
  return kortixDefaultsTail(opts);
}

/**
 * The production composition: the user's Dockerfile verbatim, then the full
 * Kortix runtime layer (toolchain + artifacts).
 *
 * `kortixToolchainLayer` ends with the newline that separates it from the
 * artifact half, so the two concatenate with NO separator; asserted in
 * sandbox/__tests__/layer-split.test.ts.
 */
export function buildLayeredDockerfile(opts: BuildLayeredDockerfileOpts): string {
  const trimmed = normalizeUserDockerfileForSnapshot(opts.userDockerfile).trimEnd();
  return `${trimmed}\n${kortixToolchainLayer(opts)}${kortixArtifactLayer(opts)}`;
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
 * kortix.yaml `residential_proxy`: the session sandbox's web traffic leaves
 * through a residential IP address. `country` is an ISO 3166-1 alpha-2 code,
 * lowercase. A boot setting, not part of the image.
 */
export interface SandboxResidentialProxy {
  country?: string;
}

const COUNTRY_RE = /^[a-z]{2}$/i;

/**
 * Read `residential_proxy`: `true` → on; a table → on, with its `country` when
 * that is a valid code (an invalid one is dropped with a warning, the proxy
 * stays on: a template that asks for a residential IP never boots without one
 * because of a typo). `false`, absent or any other value → off.
 */
export function parseResidentialProxy(value: unknown, slug = ''): SandboxResidentialProxy | undefined {
  if (value === true) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const country = (value as Record<string, unknown>).country;
  if (country === undefined) return {};
  if (typeof country === 'string' && COUNTRY_RE.test(country.trim())) return { country: country.trim().toLowerCase() };
  console.warn(`[sandbox-templates] "${slug}" residential_proxy.country is not an ISO 3166-1 alpha-2 code — ignored`);
  return {};
}

/**
 * A sandbox template defines one bootable image. Projects can declare multiple
 * via `sandbox.templates` in kortix.yaml; sessions pick one by slug. The platform
 * default template is always available without any config. An entry with
 * neither `dockerfile` nor `image` builds the platform base
 * (`PLATFORM_DEFAULT_USER_DOCKERFILE`) with its own size and settings.
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
  /** kortix.yaml `container_runtime: true` — the sandbox runs Docker. */
  containerRuntime?: boolean;
  /** kortix.yaml `entrypoint`: the command the sandbox image starts with. */
  entrypoint?: string;
  /** kortix.yaml `residential_proxy`. Not part of the image identity. */
  residentialProxy?: SandboxResidentialProxy;
  /**
   * True iff this is the platform default (no user customization). Never
   * declared in kortix.yaml — the platform synthesizes one of these.
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
 * Hardware spec for the sandbox, read from `sandbox.templates` entries in
 * kortix.yaml. Fields map onto Daytona's snapshot `Resources` (vCPU cores,
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
 * Parse `sandbox.templates` from a parsed manifest. Returns the
 * user-declared templates in declaration order. The platform default is NOT
 * included here; callers always add it themselves so it can't be shadowed by
 * a misnamed slug.
 *
 * The slug `default` is reserved for the platform-shared template — any
 * `sandbox.templates` entry that tries to claim it is dropped with a warning.
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

  // kortix.yaml: `sandbox: { templates: [...] }`.
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
    ...(row.container_runtime === true ? { containerRuntime: true } : {}),
    ...(typeof row.entrypoint === 'string' && row.entrypoint.trim() ? { entrypoint: row.entrypoint.trim() } : {}),
    ...withResidentialProxy(parseResidentialProxy(row.residential_proxy, slugRaw)),
  };
}

function withResidentialProxy(value: SandboxResidentialProxy | undefined): { residentialProxy?: SandboxResidentialProxy } {
  return value ? { residentialProxy: value } : {};
}

function sanitizeRelPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return '';
  if (trimmed.split('/').includes('..')) return '';
  return trimmed;
}
