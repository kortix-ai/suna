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

import {
  AGENT_BROWSER_VERSION as DEFAULT_AGENT_BROWSER_VERSION,
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  NODE_VERSION,
  NPM_VERSION,
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PNPM_VERSION,
  PYTHON_VERSION,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
  UV_VERSION,
} from '../runtime-versions';

/**
 * Default pinned `agent-browser` (Vercel agent-browser) CLI version baked into
 * the layer when the caller doesn't pin one explicitly. The builder may pass an
 * override via `agentBrowserVersion` to centralize the pin (and fold it into the
 * snapshot fingerprint); this fallback keeps the layer self-contained.
 */

/**
 * Chromium source for `agent-browser`. agent-browser's own `install` fetches
 * Chrome for Testing, which has NO linux-arm64 build — so we source Chromium
 * from Playwright instead: it ships both linux-x64 AND linux-arm64, and
 * `--with-deps` installs the OS libraries Chromium needs. Keep in sync with the
 * pin in apps/sandbox/Dockerfile + apps/api/src/snapshots/warm-bake.ts, and bump
 * RUNTIME_LAYER_VERSION in templates.ts when this changes so cached images
 * rebuild (the rendered Dockerfile text is not itself part of the fingerprint).
 */

/**
 * Hardcoded "platform default" Dockerfile. Used when a session boots from
 * Kortix's default template — no user customization, just Ubuntu plus the
 * Kortix runtime layer on top. The workspace gets cloned at boot.
 *
 * This is fed into `buildLayeredDockerfile` like any other user Dockerfile.
 * Exposed so the snapshot identity hash treats it as a stable input.
 */
/**
 * The `kortix` user's toolchain directories — everything the runtime resolves
 * from PATH (opencode via pnpm-global, pnpm itself, uv-managed Python, bun). Shared
 * between the toolchain layer's `ENV PATH` and the staged entrypoint script.
 * Some providers discard `ENV` at boot, so the entrypoint restores this value.
 */
export const KORTIX_USER_PATH_DIRS =
  '/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin';

export const PLATFORM_DEFAULT_USER_DOCKERFILE = [
  '# syntax=docker/dockerfile:1.7',
  '# Kortix platform default sandbox base.',
  '# Sessions clone the project workspace at boot — nothing project-specific',
  '# is baked in here. Customize via `sandbox.templates` in kortix.yaml.',
  'FROM ubuntu:24.04',
  '',
  'WORKDIR /workspace',
  '',
].join('\n') + '\n';

/**
 * Inputs for the toolchain half of the layer — everything that installs into
 * the image from the NETWORK (apt, pip, npm, bun, Playwright) plus the
 * build-time opencode warm-ups. The warm-up script is optional: without it this
 * renders against an empty build context for the CLI's local sandbox; snapshot
 * builders stage it to enable the cache-only warm-up steps.
 */
export interface KortixToolchainLayerOpts {
  /** Pinned opencode CLI version (matches platform-wide `OPENCODE_VERSION`). */
  opencodeVersion: string;
  /**
   * Pinned `agent-browser` CLI version. Optional — defaults to
   * `DEFAULT_AGENT_BROWSER_VERSION`. The builder passes the platform-wide
   * `AGENT_BROWSER_VERSION` so the pin is centralized and fingerprinted.
   */
  agentBrowserVersion?: string;
  /** Build-context path to the cache-only OpenCode warm-up script. */
  opencodeWarmupScriptPath?: string;
  /**
   * Path (in the build context) to the canonical starter `.opencode`
   * config tree (pty plugin + standard tools + skills). When provided, the
   * layer warms a real opencode PROJECT INSTANCE against it at build time so the
   * costly first-instance work (Bun plugin auto-install/transpile, models.dev
   * fetch, ripgrep) is cached into the image instead of paid on the session hot
   * path. Optional — omit to skip the instance warm-up.
   */
  opencodeConfigPath?: string;
  /**
   * True iff this image is the platform's SHARED default (no user Dockerfile —
   * `PLATFORM_DEFAULT_USER_DOCKERFILE`). Gates the post-warm-up /workspace WIPE.
   *
   * The wipe exists to clear the starter opencode config the warm-up stages into
   * /workspace, and for the shared default that is ALL /workspace holds, so
   * "delete everything" is exact. On a CUSTOM template it is not: the user's
   * Dockerfile ran FIRST and `WORKDIR /workspace` is a documented convention, so
   * any image that seeds data/caches/a toolchain there had it silently deleted by
   * a step it never asked for (and one wrapped in `set +e … true`, so it couldn't
   * even fail loudly). Custom templates therefore get a TARGETED cleanup of only
   * what the warm-up itself staged.
   *
   * KNOWN GAP (narrow, deliberately not closed here). A surviving /workspace is
   * safe for the daemon's boot clone: materializeRepo (agent-server/src/git.ts)
   * clones into a temp dir and `rm -rf`s + renames over the target, so a non-empty
   * /workspace is replaced wholesale rather than cloned INTO — no dirty-target
   * failure. The one exception is a custom image that bakes a `.git` at the
   * /workspace ROOT (not a subdir): materializeRepo keys its "using baked repo
   * checkout (warm)" fast path purely on `${target}/.git` existing. A FRESH session
   * still re-materializes correctly (the baked HEAD != the session's baseSha →
   * `mismatched`), but a restart/resume has no baseSha to compare and would reuse
   * the user's unrelated repo as the project checkout. Previously the wipe hid this
   * by deleting that .git. The safe close is in the DAEMON, not here: have the fast
   * path require a platform-written marker (the warmRepo bake / seed paths are the
   * only things that legitimately bake a /workspace/.git) instead of inferring
   * ownership from a bare .git. Tracked rather than fixed in this change because it
   * alters boot semantics for the warm-seed paths too and wants its own rollout.
   */
  isSharedDefault?: boolean;
  /**
   * Per-project COLD warm: bake the project's repo checkout into /workspace at
   * build time so a session booted from this (capture:'none') image skips the
   * boot-time git clone entirely — the daemon's git.ts fast-paths a baked
   * `${target}/.git` whose HEAD matches the session base. Requires NO memory
   * snapshot: the checkout is plain rootfs bytes that BOTH Daytona and Platinum
   * boot cold. When set, the layer clones the repo into /workspace BEFORE the
   * opencode instance warm-up (so opencode indexes the REAL project) and does
   * NOT wipe /workspace afterward. Omit for the shared, project-independent
   * default image (workspace stays empty; the daemon clones at boot).
   */
  warmRepo?: WarmRepoConfig;
}

/**
 * Render-time inputs for baking a per-project COLD warm repo checkout into the
 * image. Shared between `kortixToolchainLayer` (the full monolithic build) and
 * `buildPerProjectWarmFromBaseDockerfile` (the FROM-base fast path) so both
 * render the identical COPY step — see `buildWarmRepoCopyLines`.
 *
 * SECURITY (PHASE 1): this shape carries NO credentials. The repo is cloned
 * with the git-host credential, origin-reset to the Kortix proxy, and scrubbed
 * of all auth material API-side in Suna (`stageWarmRepoCheckout`,
 * build-context.ts) BEFORE the Dockerfile is rendered. The rendered image only
 * `COPY`s the already-sanitized plain bytes at `stagedPath`, so a git auth
 * header never enters the Dockerfile text, the build args, the OCI image
 * history, the provider build logs, or any abandoned build-context object.
 *
 * The previous design embedded `git -c http.extraHeader=<Authorization: …>`
 * directly in a `RUN` — that credential leaked into the uploaded build context,
 * the image history, the build logs, and abandoned retry objects, and deleting
 * the temp clone dir did NOT remove any of those copies.
 */
export interface WarmRepoConfig {
  /**
   * Path (relative to the build context root) to the pre-staged,
   * credential-free repo checkout produced API-side. The image `COPY`s these
   * bytes verbatim into /workspace — nothing here is secret.
   */
  stagedPath: string;
  /**
   * Visible build-context path to a tar archive of the checkout's `.git`
   * directory. Provider uploaders transfer this as one regular file.
   */
  stagedGitPath: string;
  /**
   * Branch that was checked out (the default-branch tip). Diagnostic only —
   * shell-quoted on render (never interpolated raw), so a hostile branch name
   * cannot inject a build-time shell command.
   */
  branch: string;
}

/**
 * Inputs for the artifact half of the layer — the contiguous tail that COPYs
 * Kortix's own staged build artifacts (agent + CLI binaries, entrypoint,
 * slack-cli, executor-sdk, scaffold.git) and wires the container's entrypoint.
 *
 * Every artifact path is REQUIRED, deliberately: an agent-less image would
 * still build, still hash to a fresh snapshot identity, and only fail once a
 * session tried to connect to it. Callers that legitimately have no artifacts
 * to stage call `kortixToolchainLayer` alone — "no artifacts" is a different
 * call, not a forgotten field.
 */
export interface KortixArtifactLayerOpts {
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
  /** Path to the platform-managed machine guide, copied to `/MACHINE.md`. */
  machineDocPath: string;
  /**
   * Path the snapshot builder will reference for the slack-cli source tree
   * (apps/sandbox/slack-cli). The layer COPYs it into
   * /opt/kortix/apps/sandbox/slack-cli
   * and runs install-shims.sh to wire each *.ts (excluding lib/) as a
   * /usr/local/bin/<name> shim — that's how `slack` lands on PATH for the
   * agent to invoke from inside the sandbox. (The Executor moved into the
   * `kortix` CLI as `kortix executor` / `kortix executor mcp`.)
   */
  slackCliPath: string;
  /**
   * Path the snapshot builder will reference for packages/executor-sdk.
   * The agent CLI imports it via the same repo-relative path in dev and in
   * real snapshots.
   */
  executorSdkPath: string;
  /**
   * Path (in the build context) to the baked full gateway model catalog JSON.
   * COPY'd into the image so the no-restart warm seed — which has no sandbox
   * token / projectId to fetch the catalog at PARK — gets the full model picker
   * instead of the daemon's minimal fallback. Optional; omit to skip.
   */
  catalogPath?: string;
}

export interface BuildLayeredDockerfileOpts
  extends KortixToolchainLayerOpts,
    KortixArtifactLayerOpts {
  /** Literal contents of the user's project Dockerfile. */
  userDockerfile: string;
}

/**
 * The network-install half of the Kortix runtime layer: the apt floor, the
 * uv-managed Python, opencode + its baked config deps, bun, the
 * build-time opencode warm-ups (incl. the optional per-project repo bake), and
 * agent-browser + its Playwright Chromium.
 *
 * Renders against an EMPTY build context — it stages nothing. Ends with a
 * trailing newline so it concatenates directly onto `kortixArtifactLayer`.
 */
// Single-quote a value for safe embedding in a build-time bash RUN.
const shq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * The per-project COLD warm bake step: `COPY` the credential-free repo checkout
 * that Suna already cloned, origin-reset, and scrubbed API-side
 * (`stageWarmRepoCheckout`) into /workspace. NO auth material is present — this
 * is the PHASE 1 fix for the credential leak that the old in-Dockerfile clone
 * caused (the git auth header used to be embedded in a `RUN` that shipped to
 * object storage, baked into OCI history, and printed to build logs).
 *
 * Shared verbatim between `kortixToolchainLayer` (the monolithic build) and
 * `buildPerProjectWarmFromBaseDockerfile` (the FROM-base fast path) — the two
 * MUST render byte-identical steps so the baked checkout is the same either
 * way. Returns `[]` when there's no repo to bake (the shared,
 * project-independent default image).
 */
function buildWarmRepoCopyLines(warmRepo: WarmRepoConfig | undefined): string[] {
  if (!warmRepo) return [];
  return [
    '',
    '# ─── Per-project COLD warm: bake repo checkout into /workspace ──────',
    '# The repo was cloned with the git-host credential, origin-reset to the',
    '# Kortix proxy, and scrubbed of ALL auth material API-side in Suna before',
    '# this Dockerfile was rendered. This image only COPYs the sanitized plain',
    '# bytes — no git credential ever enters the Dockerfile, build args, image',
    '# history, or build logs. See PHASE 1 provider-migration hardening.',
    // Empty whatever an earlier layer left in /workspace, then COPY the baked
    // checkout. `cd /` first so the build shell CWD isn't an inode we delete
    // (WORKDIR is /workspace); `-mindepth 1` keeps the /workspace dir itself.
    'RUN cd / && mkdir -p /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    // `--chown=kortix:kortix` so the baked checkout lands owned by the non-root
    // runtime user (COPY defaults to uid/gid 0). opencode + the daemon run as
    // `kortix` and must be able to write /workspace and its `.git` at runtime.
    `COPY --chown=kortix:kortix ${warmRepo.stagedPath}/ /workspace/`,
    // Daytona uploads each COPY source as a separate context object. Transfer
    // Git metadata as one visible file, then restore the canonical directory.
    `COPY ${warmRepo.stagedGitPath} /tmp/kortix-warm-repo-git.tar`,
    'RUN rm -rf /workspace/.git && mkdir -p /workspace/.git && tar -xf /tmp/kortix-warm-repo-git.tar -C /workspace/.git --strip-components=1 && rm -f /tmp/kortix-warm-repo-git.tar && chown -R kortix:kortix /workspace/.git',
    // Verify the baked checkout is a real repo. The branch is shell-quoted via
    // `shq` (never interpolated raw), so a hostile branch name cannot inject a
    // build-time shell command — closing the latent sink in the old echo.
    `RUN git -C /workspace rev-parse HEAD >/dev/null 2>&1 && printf 'warm-repo: baked %s on %s\\n' "$(git -C /workspace rev-parse HEAD)" ${shq(warmRepo.branch)}`,
    '',
  ];
}

/**
 * Warm a real opencode PROJECT INSTANCE at build time. The first time opencode
 * creates an instance for a project dir it loads that dir's .opencode
 * surface — importing the pty plugin + tools — which makes Bun auto-install /
 * transpile the plugin dep tree and opencode fetch its model catalog +
 * ripgrep. On a fresh VM that's a one-time ~6s stall (up to ~60s when npm /
 * GitHub are contended) that gates runtimeReady right on the session hot path.
 * We pay it ONCE here, against the canonical starter config staged at the SAME
 * runtime path (/workspace) so Bun's content-addressed transpile cache hits at
 * boot. For the SHARED default image we then wipe /workspace (the session
 * clones into it). For a PER-PROJECT COLD warm (warmRepo set) the repo is
 * already baked at /workspace and we KEEP it — the daemon boots off the baked
 * checkout with NO clone. For a CUSTOM template we remove only the config we
 * staged: /workspace is the user's. Either way the warmed caches under
 * the `kortix` user's home persist in the image layer. Measured: cold first-instance
 * 6–60s → ~2–4s after this bake. Requires opencode + bun + the baked config
 * deps to already be present in the image (either from the toolchain layer
 * above, or inherited via FROM on the fast path), so it must come after them.
 * Best effort: a build without network (or a warm-up failure) just falls back
 * to the runtime cost — set +e + trailing `true` keep the image build green.
 *
 * Shared between `kortixToolchainLayer` and `buildPerProjectWarmFromBaseDockerfile`
 * so both render byte-identical warm-up text. Returns `[]` when there's no
 * starter config to warm against.
 */
function buildOpencodeInstanceWarmupLines(opts: {
  opencodeConfigPath?: string;
  opencodeWarmupScriptPath?: string;
  warmRepo?: WarmRepoConfig;
  isSharedDefault?: boolean;
}): string[] {
  const { opencodeConfigPath, opencodeWarmupScriptPath, warmRepo, isSharedDefault } = opts;
  if (!opencodeConfigPath || !opencodeWarmupScriptPath) return [];
  const cleanup = warmRepo ? 'keep' : isSharedDefault ? 'wipe' : 'targeted';
  return [
    `COPY --chown=kortix:kortix ${opencodeConfigPath}/ /opt/kortix/warm-config/.opencode/`,
    // Same "does it actually bundle" check as the opencode-config-deps
    // verification above, but exercised against the REAL starter tool
    // files (web_search / scrape_webpage / image_search / memory / show)
    // instead of just their axios/form-data override targets — this is
    // what actually walks the full transitive dependency tree
    // (firecrawl-js, tavily-core, replicate) that ToolRegistry resolves
    // on a session's first prompt. Deliberately its own RUN step (not
    // folded into the `set +e` warm-up below): a tool that can't bundle
    // breaks every session's first prompt, not just startup latency, so
    // it must fail the build — the warm-up readiness probe below stays
    // best-effort as before.
    'RUN cd /opt/kortix/warm-config/.opencode \\',
    '    && rm -rf node_modules \\',
    '    && ln -s /opt/kortix/opencode-config-deps/node_modules node_modules \\',
    '    && bun build tools/*.ts --target=bun --outdir=/tmp/opencode-tools-bundle-check \\',
    '    && rm -rf /tmp/opencode-tools-bundle-check \\',
    '    && echo "opencode-config-deps: starter tool files bundle cleanly"',
    '',
    `COPY --chown=kortix:kortix ${opencodeWarmupScriptPath} /tmp/kortix-opencode-warmup`,
    // Stage the canonical starter opencode config so the instance warm-up
    // has the pty plugin + tools to load. For a per-project warm the baked
    // repo may already ship its own .opencode — keep it (its config
    // is what the session actually resolves at runtime) and only fall back
    // to the staged starter when the repo has none.
    // The warm-up script records whether the starter config in /workspace is
    // ours and limits cleanup accordingly.
    // Three cases, and only one of them may delete indiscriminately:
    //  • per-project COLD warm (warmRepo): KEEP the baked repo checkout so
    //    the daemon boots off it with no clone.
    //  • SHARED default: /workspace contains only what this warm-up put
    //    there (the base is `PLATFORM_DEFAULT_USER_DOCKERFILE` — a FROM and a
    //    WORKDIR), so wiping it is exact, and it also clears anything opencode
    //    itself dropped while serving. The session clones into it at boot.
    //  • CUSTOM template: the user's Dockerfile owns /workspace. Remove ONLY
    //    the starter config we staged (and the .kortix dir if that leaves it
    //    empty) — never their bytes. `rmdir` is the no-op-unless-empty form on
    //    purpose; a user's own /workspace/.kortix survives untouched.
    `RUN bash /tmp/kortix-opencode-warmup instance ${cleanup}; rm -f /tmp/kortix-opencode-warmup`,
    '',
  ];
}

export function kortixToolchainLayer(opts: KortixToolchainLayerOpts): string {
  const {
    opencodeVersion,
    agentBrowserVersion = DEFAULT_AGENT_BROWSER_VERSION,
    opencodeWarmupScriptPath,
    opencodeConfigPath,
    isSharedDefault,
    warmRepo,
  } = opts;

  const warmRepoClone = buildWarmRepoCopyLines(warmRepo);

  return [
    '',
    '# ─── Kortix runtime layer (auto-injected) ──────────────────────────',
    '# Everything below is added by the Kortix snapshot builder. Do not',
    "# edit by hand — your project Dockerfile above is preserved verbatim.",
    '',
    'USER root',
    // tmux: lets the agent run long-running processes (dev servers for preview)
    // in a detached session that survives the agent\'s bash tool call.
    // Office, PDF, OCR, and LaTeX tools support the starter marketplace skills.
    // Bake them into every layered image so custom sandbox Dockerfiles get the
    // same system tool floor as the platform default image.
    // iproute2 (`ip`) + iputils-arping are REQUIRED on Platinum: a
    // snapshot-restored VM keeps its snapshot-baked IP until the
    // host's reconfigure_net runs `ip addr flush/add` + a gratuitous `arping`
    // inside the guest. Without these the IP never changes → the guest stays on
    // the baked IP while the edge routes to the allocated IP → every request
    // 502s. (Harmless on Daytona, which doesn't memory-restore.)
    // apt is non-interactive by construction here (no TTY), but a package with a
    // debconf prompt (tzdata, libreoffice's font EULAs) can still stall or fail
    // the build. This ENV used to be supplied only by whatever the USER's base
    // image happened to leak in — ubuntu:24.04 doesn't set it, so the floor was
    // relying on luck. Set it ourselves. It persists to runtime deliberately:
    // the agent's own `apt-get install` in a session has no TTY either, and a
    // debconf prompt there is an unrecoverable hang, not a question anyone answers.
    'ENV DEBIAN_FRONTEND=noninteractive',
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git gzip libatomic1 sudo unzip tmux iproute2 iputils-arping \\',
    '        build-essential ffmpeg fonts-dejavu fonts-liberation fonts-noto fonts-noto-cjk \\',
    '        latexmk libreoffice pandoc pkg-config poppler-utils qpdf tesseract-ocr \\',
    '        texlive-bibtex-extra texlive-fonts-recommended texlive-latex-base \\',
    '        texlive-latex-extra texlive-latex-recommended \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    'RUN useradd --create-home --shell /bin/bash --user-group kortix \\',
    "    && printf 'kortix ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/kortix \\",
    '    && chmod 0440 /etc/sudoers.d/kortix \\',
    '    && mkdir -p /workspace /opt/kortix /opt/pw-browsers /ephemeral/kortix-master/opencode \\',
    '        /home/kortix/.local/bin /home/kortix/.local/share/pnpm/bin /home/kortix/.bun/bin \\',
    '    && chown -R kortix:kortix /workspace /opt/kortix /opt/pw-browsers /ephemeral /home/kortix',
    'ENV PNPM_HOME=/home/kortix/.local/share/pnpm \\',
    `    PATH=${KORTIX_USER_PATH_DIRS}:$PATH`,
    'USER kortix',
    '',
    // Install one exact managed Python and expose it as python/python3. Agents
    // use `uv run --with` for dependencies instead of sharing a global venv.
    `RUN case "$(uname -m)" in \\`,
    `      x86_64) uv_arch=x86_64; uv_sha=${UV_SHA256_AMD64} ;; \\`,
    `      aarch64|arm64) uv_arch=aarch64; uv_sha=${UV_SHA256_ARM64} ;; \\`,
    `      *) echo "unsupported uv architecture: $(uname -m)" >&2; exit 1 ;; \\`,
    '    esac \\',
    '    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/uv.tar.gz \\',
    `         "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-\${uv_arch}-unknown-linux-gnu.tar.gz" \\`,
    '    && echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c - \\',
    '    && tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /home/kortix/.local/bin \\',
    '    && rm /tmp/uv.tar.gz \\',
    `    && uv --version | grep -Eq '^uv ${UV_VERSION}( |$)' \\`,
    `    && UV_PYTHON_DOWNLOADS=automatic uv python install --default ${PYTHON_VERSION} \\`,
    `    && python -c 'import sys; assert sys.version_info[:3] == (${PYTHON_VERSION.replaceAll('.', ', ')}); print("managed python:", sys.version)' \\`,
    `    && python3 -c 'import sys; assert sys.version_info[:3] == (${PYTHON_VERSION.replaceAll('.', ', ')})'`,
    '',
    // Install pnpm's versioned standalone release artifact after verifying the
    // repository-controlled checksum. pnpm then owns the JavaScript runtime
    // floor: Node comes from `pnpm runtime`, while npm and global CLIs live in
    // pnpm's isolated global package store.
    'ENV SHELL=/bin/bash',
    'RUN case "$(uname -m)" in \\',
    `      x86_64) pnpm_arch=x64; pnpm_sha=${PNPM_SHA256_AMD64} ;; \\`,
    `      aarch64|arm64) pnpm_arch=arm64; pnpm_sha=${PNPM_SHA256_ARM64} ;; \\`,
    `      *) echo "unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \\`,
    '    esac \\',
    '    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/pnpm.tar.gz \\',
    `         "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz" \\`,
    '    && echo "${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c - \\',
    '    && tar -xzf /tmp/pnpm.tar.gz -C /home/kortix/.local/bin \\',
    '    && rm /tmp/pnpm.tar.gz \\',
    `    && test "$(pnpm --version)" = "${PNPM_VERSION}" \\`,
    `    && pnpm runtime set node ${NODE_VERSION} -g \\`,
    `    && test "$(node --version)" = "v${NODE_VERSION}" \\`,
    `    && pnpm add -g "npm@${NPM_VERSION}" \\`,
    `    && test "$(npm --version)" = "${NPM_VERSION}"`,
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
    // apt + pip floors and DELIBERATELY ABOVE everything below it: the opencode
    // install, the `opencode serve` migration-bake, the config-deps bun install,
    // the per-project warm-repo clone, and the opencode instance warm-up. Several
    // of those layers are NON-DETERMINISTIC by construction — the migration-bake
    // writes a sqlite db with live timestamps, the config-deps install churns
    // node_modules mtimes, and the warm-repo clone bakes a fresh short-lived git
    // credential into its RUN text on every single invocation. The providers'
    // build caches are CONTENT-ADDRESSED (Daytona especially — it has no
    // Docker-style instruction-text cache and no `swapAgent` fast path), so ANY
    // non-deterministic layer BUSTS the cache for everything chained BELOW it.
    //
    // The kortix-agent SOURCE feeds the snapshot fingerprint (see
    // AGENT_RUNTIME_ARTIFACTS in apps/api/src/snapshots/templates.ts), so any
    // agent-server code change mints a BRAND-NEW snapshot name → a full rebuild on
    // Daytona (no agent-swap). If Chromium sat below the migration-bake (as it did
    // through v0.10.11), every such rebuild MISSED cache and re-downloaded ~150MB
    // from cdn.playwright.dev — overrunning the session-ready window and breaking
    // fresh-sandbox boots (the v0.10.11 "session never starts" incident). Keeping
    // Chromium on purely deterministic parents makes its content hash stable
    // across agent-source churn: it is fetched at most ONCE per pinned Playwright/
    // agent-browser version and cache-reused for every rebuild after. The retry
    // loop + 30-min timeout below are the SAFETY NET for that one cold fetch.
    'ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \\',
    '    AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium \\',
    '    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage \\',
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
    `        pnpm dlx playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && break; \\`,
    '        echo "playwright chromium install attempt $pw_try failed, retrying..."; \\',
    '        sleep $((pw_try*10)); \\',
    '    done \\',
    '    && sudo rm -rf /var/lib/apt/lists/* \\',
    `    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \\`,
    '    && test -n "$pw_chrome" \\',
    '    && ln -sf "$pw_chrome" /home/kortix/.local/bin/chromium \\',
    '    && mkdir -p /home/kortix/.agent-browser/browsers \\',
    '    && ln -sf "$(dirname "$pw_chrome")" /home/kortix/.agent-browser/browsers/chrome-linux64 \\',
    '    && chromium --version \\',
    // Assert agent-browser RESOLVES the browser via its env-independent cache —
    // match the resolved path (deterministic), not the browser NAME (which is
    // "Chromium" on arm64 but "Google Chrome for Testing" on x64). The doctor
    // "Launch test" may itself fail under cross-arch QEMU emulation; we read the
    // detection line, not the launch verdict, so the gate is emulation-safe.
    "    && env -u AGENT_BROWSER_EXECUTABLE_PATH agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'",
    '',
    `RUN pnpm add -g --allow-build=opencode-ai "opencode-ai@${opencodeVersion}" \\`,
    '    && command -v opencode \\',
    '    && opencode --version',
    '',
    // Bake OpenCode's "one time database migration" at BUILD time. The first time
    // opencode serves, it migrates its sqlite schema — logged as "Performing one
    // time database migration (may take a few minutes)" — before it answers any
    // request. On a fresh VM that runs on the session hot path, adding ~15-35s
    // before opencode replies to /session; on a restored warm snapshot that
    // window is exactly what surfaces as the FE's "sandbox not ready" 503s.
    // opencode's db
    // lives in the baked `kortix` home, so we
    // run opencode here once to complete the migration and bake the migrated db
    // into the image layer. Every boot afterwards — cold or warm-snapshot restore —
    // then finds an already-migrated db and answers in ~2-3s. Env MUST match the
    // daemon's spawn (apps/kortix-sandbox-agent-server/src/opencode.ts). Best
    // effort: if opencode can't serve at build time it just falls back to the
    // old boot-time migration — never fail the whole image build over a warm-up.
    ...(opencodeWarmupScriptPath ? [
      `COPY --chown=kortix:kortix ${opencodeWarmupScriptPath} /tmp/kortix-opencode-warmup`,
      'RUN bash /tmp/kortix-opencode-warmup migration; rm -f /tmp/kortix-opencode-warmup',
    ] : []),
    '',
    // Bun runtime for the agent CLIs (slack, …) + `kortix executor mcp`.
    // Download one versioned release artifact and verify its checksum before
    // extracting it. The public installer script is not part of the trust path.
    'RUN case "$(uname -m)" in \\',
    `      x86_64) bun_arch=x64; bun_sha=${BUN_SHA256_AMD64} ;; \\`,
    `      aarch64|arm64) bun_arch=aarch64; bun_sha=${BUN_SHA256_ARM64} ;; \\`,
    `      *) echo "unsupported Bun architecture: $(uname -m)" >&2; exit 1 ;; \\`,
    '    esac \\',
    '    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/bun.zip \\',
    `         "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-\${bun_arch}.zip" \\`,
    '    && echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c - \\',
    '    && unzip -q /tmp/bun.zip -d /tmp/bun \\',
    '    && install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /home/kortix/.bun/bin/bun \\',
    '    && ln -sf bun /home/kortix/.bun/bin/bunx \\',
    '    && rm -rf /tmp/bun /tmp/bun.zip \\',
    `    && test "$(bun --version)" = "${BUN_VERSION}"`,
    '',
    // Pre-install the OpenCode tool/plugin dependencies once, at image-build time,
    // into a stable baked location. The cloned config dir's plugin + tools import
    // @opencode-ai/plugin (+ its effect/zod/@opencode-ai/sdk tree) and
    // @mendable/firecrawl-js / @tavily/core / replicate, and OpenCode runs
    // `bun install` in that dir the first time a session opens — but node_modules/
    // bun.lock are gitignored, so that boot install would otherwise fetch over the
    // network (a 1.5–6s — sometimes minutes — stall on the session hot path). The
    // daemon's ensureOpencodeConfigDeps() links this baked node_modules + bun.lock
    // into the resolved config dir before opencode starts, making the boot install a
    // verified OFFLINE no-op. The same user-local caches warm Bun.
    //
    // CRITICAL — @opencode-ai/plugin is pinned to the OPENCODE BINARY version
    // (`opencodeVersion`), NOT the version declared in the project/starter
    // package.json. OpenCode loads the plugin SDK that matches its OWN binary: it
    // overwrites whatever @opencode-ai/plugin the config dir pins with its binary
    // version, fetching it over the network if absent. Baking the stale starter pin
    // (e.g. 1.17.9 while the binary is 1.17.11) therefore left opencode re-fetching
    // the matching plugin on EVERY boot — the ~5–8s "opencode-session-created" gap.
    // Baking the binary version makes opencode find it already present → no fetch.
    // Bump RUNTIME_LAYER_VERSION in templates.ts when this step changes.
    // NOTE: this dependency set (and the "axios"/"form-data" security overrides
    // below) is duplicated in packages/starter/templates/base/.opencode/package.json.
    // Keep both in sync —
    // a version bump made in only one place is exactly how this file's axios
    // override once diverged and shipped a bundle-breaking install (see the
    // verification RUN step right below, added after that incident).
    'RUN mkdir -p /opt/kortix/opencode-config-deps \\',
    '    && cd /opt/kortix/opencode-config-deps \\',
    `    && printf '{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@opencode-ai/plugin":"${opencodeVersion}","@tavily/core":"^0.7.3","replicate":"^1.4.0"},"overrides":{"axios":"1.16.0","form-data":"4.0.6"}}' > package.json \\`,
    '    && bun install',
    '',
    // Verify the baked tree is actually usable by OpenCode's own runtime
    // bundler (Bun, invoked live by ToolRegistry the first time a session
    // resolves its tools) — not just that `bun install` exited 0. A CVE-driven
    // axios override bump here once produced an installed tree that resolved
    // fine but failed to BUNDLE at session runtime
    // (`AggregateError: N errors building ".../axios/lib/utils.js"`), which
    // silently baked into every sandbox cloned from this image until a user
    // hit it on their very first prompt. Bundling the override targets here,
    // at build time, turns that failure mode into a build failure instead —
    // intentionally NOT `set +e`: an unbundlable dependency tree must fail
    // the image build, unlike the best-effort warm-up steps below.
    'RUN cd /opt/kortix/opencode-config-deps \\',
    '    && bun build node_modules/axios/lib/utils.js node_modules/form-data/lib/form_data.js --target=bun --outdir=/tmp/opencode-deps-bundle-check \\',
    '    && rm -rf /tmp/opencode-deps-bundle-check \\',
    '    && echo "opencode-config-deps: baked tree bundles cleanly"',
    '',
    // Per-project COLD warm: bake the repo checkout into /workspace BEFORE the
    // opencode instance warm-up below, so opencode indexes the REAL project (its
    // config, file tree, sqlite rows) — all baked into the cold rootfs. git is
    // installed by the first apt RUN above, so this is safe here. For the shared
    // default image warmRepo is absent → /workspace stays empty (unchanged).
    // Placed AFTER the agent-browser/Chromium layer above — see that block's
    // comment for why the order matters (this step's RUN text is never
    // cache-stable, so nothing cache-sensitive may sit downstream of it).
    ...warmRepoClone,
    ...buildOpencodeInstanceWarmupLines({ opencodeConfigPath, opencodeWarmupScriptPath, warmRepo, isSharedDefault }),
    // The staged-artifact tail lives in `kortixArtifactLayer`. The split is
    // here — everything above installs from the network into an empty build
    // context; everything below COPYs bytes the caller had to stage first.
  ].join('\n') + '\n';
}

/**
 * The staged-artifact half of the Kortix runtime layer: the COPYs of Kortix's
 * own build outputs (agent + CLI binaries, entrypoint, slack-cli,
 * executor-sdk, the optional LLM catalog, scaffold.git), the unpack/shim RUN
 * that puts them on PATH, and the container's ENV/WORKDIR/EXPOSE/ENTRYPOINT.
 *
 * Every path here must exist in the build context — see
 * `KortixArtifactLayerOpts` for why none of them are optional.
 */
export function kortixArtifactLayer(opts: KortixArtifactLayerOpts): string {
  const {
    agentBinaryPath,
    cliBinaryPath,
    entrypointScriptPath,
    machineDocPath,
    slackCliPath,
    executorSdkPath,
    catalogPath,
  } = opts;

  return [
    'USER root',
    `COPY ${agentBinaryPath} /tmp/kortix-agent.gz`,
    `COPY ${cliBinaryPath} /tmp/kortix.gz`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    `COPY ${machineDocPath} /MACHINE.md`,
    // Keep the repo-relative layout so CLIs can import shared packages.
    `COPY ${slackCliPath}/ /opt/kortix/apps/sandbox/slack-cli/`,
    `COPY ${executorSdkPath}/ /opt/kortix/packages/executor-sdk/`,
    // Full gateway model catalog, baked at build so the token-less no-restart
    // warm seed serves the full picker (daemon reads KORTIX_LLM_CATALOG_FILE).
    ...(catalogPath ? [`COPY ${catalogPath} /opt/kortix/llm-catalog.json`] : []),
    // Canonical scaffold repo (bare). Its root commit matches every seeded
    // project's root (pinned dates, seed.ts), enabling local-clone +
    // delta-fetch repo materialization in the daemon (git.ts).
    `COPY scaffold.git /opt/kortix/scaffold.git`,
    'RUN gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\',
    '    && gunzip -c /tmp/kortix.gz > /usr/local/bin/kortix \\',
    '    && rm /tmp/kortix-agent.gz /tmp/kortix.gz \\',
    '    && bash -n /usr/local/bin/kortix-entrypoint \\',
    '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \\',
    // Fail the build loudly if the CLI didn't land — every sandbox must ship it.
    '    && kortix --version \\',
    '    && chown -R kortix:kortix /opt/kortix /workspace /ephemeral',
    '',
    // The daemon clones the project workspace at boot using KORTIX_PROJECT_AUTO_CLONE
    // — nothing project-specific is baked into the image. /workspace is created
    // empty here; the daemon's materializeRepo path fills it.
    'ENV KORTIX_WORKSPACE=/workspace',
    'USER kortix',
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ].join('\n');
}

/**
 * The production composition: the user's Dockerfile verbatim, then the full
 * Kortix runtime layer (toolchain + artifacts).
 *
 * The two halves are concatenated with NO separator — `kortixToolchainLayer`
 * already ends with the newline that used to sit between them in the single
 * array this was split out of, so the output is byte-identical to the
 * pre-split renderer by construction. That identity is what lets
 * RUNTIME_LAYER_VERSION (templates.ts) stay put across the split; it is
 * asserted directly in sandbox/__tests__/layer-split.test.ts.
 */
export function buildLayeredDockerfile(opts: BuildLayeredDockerfileOpts): string {
  const trimmed = normalizeUserDockerfileForSnapshot(opts.userDockerfile).trimEnd();
  return `${trimmed}\n${kortixToolchainLayer(opts)}${kortixArtifactLayer(opts)}`;
}

/** Inputs for the FROM-base per-project warm fast path — see
 *  {@link buildPerProjectWarmFromBaseDockerfile}. */
export interface PerProjectWarmFromBaseOpts {
  /**
   * Registry-addressable reference to an ALREADY-BUILT, ACTIVE image that has
   * the full Kortix runtime layer baked in (apt/pip/opencode/bun/agent-browser
   * + Chromium + the artifact tail) — in practice the shared default image's
   * provider-reported image ref (e.g. Daytona `Snapshot.imageName`). The
   * caller (ensurePerProjectWarmImage in apps/api/src/snapshots/builder.ts) is
   * responsible for resolving this and MUST verify the source snapshot is
   * `active` first; a `FROM` of a not-yet-built or missing image fails the
   * whole bake immediately (no opportunistic retry-as-full-rebuild happens
   * inside this function — that fallback lives in the caller).
   */
  baseImageRef: string;
  /** Repo to bake into /workspace — always set; a per-project warm with no
   *  repo to clone has nothing for this fast path to add over the base. */
  warmRepo: WarmRepoConfig;
  /** Same meaning as {@link KortixToolchainLayerOpts.opencodeConfigPath}. */
  opencodeConfigPath?: string;
  /** Build-context path to the cache-only OpenCode warm-up script. */
  opencodeWarmupScriptPath?: string;
}

/**
 * Per-project COLD warm, FAST PATH: `FROM` an already-built runtime image
 * (the shared default) instead of re-running the ~15-layer toolchain install
 * (apt/pip/opencode/bun/agent-browser+Chromium) from scratch.
 *
 * THIS is the actual fix for the Chromium re-download bug (prod incident,
 * v0.10.11 rollback): `kortixToolchainLayer`'s comment already establishes
 * that the toolchain RUN text up to and including the Chromium install is
 * byte-identical between the shared default build and every per-project warm
 * bake — so in principle a build-cache hit should always be available. In
 * practice it was not reliable enough under concurrency (3+ simultaneous
 * per-project bakes), and a full monolithic rebuild is fundamentally an
 * OPPORTUNISTIC cache hit — the provider's build backend is free to evict,
 * shard across builder nodes, or otherwise not share that cache, and there is
 * no way to observe or guarantee it from here. `FROM <baseImageRef>` removes
 * the dependency on that cache entirely: Chromium (and everything else in the
 * toolchain) is INHERITED, not re-executed, so there is no download to miss.
 *
 * Only adds the two per-project-specific steps on top of the base — the
 * warm-repo COPY (credential-free, sanitized checkout staged API-side) and the
 * opencode instance re-warm against the real project — using the EXACT SAME
 * line-builders as the monolithic path
 * (`buildWarmRepoCopyLines` / `buildOpencodeInstanceWarmupLines`), so the
 * resulting /workspace content is equivalent to what the full rebuild would
 * have produced. Everything else — WORKDIR, ENV, ENTRYPOINT, EXPOSE, the
 * baked agent/CLI binaries — is inherited from the base image, since Docker
 * FROM semantics carry those forward automatically; this function does not
 * (and must not) re-declare them.
 */
export function buildPerProjectWarmFromBaseDockerfile(opts: PerProjectWarmFromBaseOpts): string {
  const { baseImageRef, warmRepo, opencodeConfigPath, opencodeWarmupScriptPath } = opts;
  return [
    `FROM ${baseImageRef}`,
    '',
    '# ─── Per-project COLD warm (FROM-base fast path, auto-injected) ─────',
    '# Everything above this line is INHERITED from the already-built default',
    '# runtime image (apt/pip/opencode/bun/agent-browser + Chromium are already',
    '# baked in) — nothing below re-installs any of it. This is what makes the',
    '# Chromium install a guaranteed inherit instead of an opportunistic',
    '# build-cache hit. Do not add toolchain RUNs here — they belong in',
    '# kortixToolchainLayer, which this stage deliberately skips.',
    '',
    // Run as the base image's non-root runtime user (`kortix`): /workspace is
    // kortix-owned in the base, and the opencode instance re-warm below resolves
    // its baked caches from HOME=/home/kortix. The warm-repo step is MY
    // credential-free COPY (buildWarmRepoCopyLines) — NOT the old credentialed
    // clone — so no git auth header is ever rendered into this FROM-base stage.
    'USER kortix',
    ...buildWarmRepoCopyLines(warmRepo),
    ...buildOpencodeInstanceWarmupLines({ opencodeConfigPath, opencodeWarmupScriptPath, warmRepo, isSharedDefault: false }),
  ].join('\n') + '\n';
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
 * via `sandbox.templates` in kortix.yaml; sessions pick one by slug. The platform
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

  // kortix.yaml: `sandbox: { templates: [...] }` — legacy kortix.toml:
  // `[[sandbox.templates]]` (array of tables). Both parse to the same
  // `sandbox.templates` shape below.
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
