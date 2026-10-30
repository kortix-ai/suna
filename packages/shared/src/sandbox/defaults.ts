/**
 * The Kortix defaults: what every Kortix sandbox image carries, in one place.
 *
 * Every image the platform builds for an agent session renders these steps
 * verbatim and in this order: the platform default image and every custom
 * template (`buildLayeredDockerfile`), and My Kortix
 * (`buildMyKortixSandboxDockerfile`). `__tests__/defaults.test.ts` fails when an
 * image lacks them. Change a default here, and every image gets it.
 *
 * - `kortixDefaultsSetup()` installs from the network: the base apt packages
 *   and shell tools, the `kortix` user with passwordless sudo, uv with the
 *   managed Python, pnpm with Node.js and npm, Bun, and pi's system packages.
 * - `kortixDefaultsTail(opts)` installs what the builder stages: the agent
 *   daemon, the `kortix` CLI, the entrypoint, `/MACHINE.md`, the Slack CLI
 *   shims, the scaffold repo, the managed skills, the runtime-assets record,
 *   the shell profile, and the container's ENV, WORKDIR and ENTRYPOINT.
 *
 * An image's own tooling sits between the two. Project agents get the
 * workstation (`kortixWorkstationTooling` in dockerfile-layer.ts: document
 * tools, the Python package floor, Chromium with agent-browser, the desktop).
 * My Kortix gets none: it hands that work to a project agent's session.
 */

import {
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  NODE_VERSION,
  NPM_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PNPM_VERSION,
  PI_SUPPLIED_PACKAGES,
  PI_SYSTEM_PACKAGES,
  PYTHON_VERSION,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
  UV_VERSION,
  assertPiSystemPackage,
} from '../runtime-versions';
import {
  SANDBOX_SHELL_TOOL_APT_LIST,
  SANDBOX_SHELL_TOOL_LINK_COMMAND,
} from './shell-tools';
import {
  SANDBOX_CLI_OWNERSHIP_COMMAND,
  SANDBOX_MANAGED_SKILLS_DIR,
  SANDBOX_RUNTIME_ASSETS_STATE_COMMAND,
  SANDBOX_RUNTIME_ASSETS_STATE_PATH,
} from './platform-binaries';

/** The base of the platform default image and of My Kortix. */
export const SANDBOX_BASE_IMAGE = 'ubuntu:24.04';

/**
 * The `kortix` user's toolchain directories — everything the runtime resolves
 * from PATH (pnpm-global tools, pnpm itself, uv-managed Python, bun). Shared
 * between the defaults' `ENV PATH` and the staged entrypoint script.
 * Some providers discard `ENV` at boot, so the entrypoint restores this value.
 */
export const KORTIX_USER_PATH_DIRS =
  '/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin';

/**
 * Live project secrets on tmpfs. The kortix-agent daemon writes this file
 * (apps/kortix-sandbox-agent-server/src/harness/shared/agent-env-file.ts `AGENT_ENV_SH`).
 */
export const KORTIX_AGENT_ENV_FILE = '/dev/shm/kortix/agent-env.sh';

/**
 * Login-shell hook baked into every image that runs the web terminal. The
 * `zz-` prefix sorts it last in /etc/profile.d, so no other profile script can
 * undo it.
 */
export const KORTIX_SHELL_PROFILE_PATH = '/etc/profile.d/zz-kortix.sh';

/**
 * The login-shell hook: restore the Kortix tool directories on PATH, then load
 * the live project secrets.
 *
 * Why it exists. The web terminal spawns `/bin/bash -l`
 * (kortix-sandbox-agent-server routes/pty.ts). A login shell sources
 * /etc/profile. Debian's /etc/profile resets PATH for every login shell
 * (non-root: `/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games`), so
 * `pnpm`, `python`, and `bun` were `command not found` in the
 * terminal of every Debian-based custom template. Ubuntu's /etc/profile does
 * not touch PATH. The agent's own shells are non-login `bash -c` and were never
 * affected.
 *
 * Contract:
 * - Prepends only the Kortix dirs that are missing, in `KORTIX_USER_PATH_DIRS`
 *   order. Every other entry keeps its position, including root's sbin dirs.
 *   Sourcing it again changes nothing.
 * - Never adds an empty PATH entry (the current directory).
 * - Loads project secrets only when the file is readable. The daemon writes it
 *   0600 as `kortix`, so other users skip it.
 * - POSIX sh (dash sources /etc/profile.d too). No single quotes and no
 *   backslashes, so `kortixShellProfileRun` can emit each line as one
 *   single-quoted `echo` argument that every provider's Dockerfile parser
 *   keeps intact (E2B strips the backslash from a quoted `\n`, buildah rejects
 *   heredocs).
 */
export function kortixShellProfileScript(): string {
  const dirs = KORTIX_USER_PATH_DIRS.split(':').join(' ');
  return [
    '# Kortix sandbox shell hook. Written by the Kortix runtime layer. Do not edit.',
    '# Debian resets PATH in /etc/profile for login shells: restore the Kortix tool dirs.',
    'kortix_path_prefix=',
    `for kortix_path_dir in ${dirs}; do`,
    '  case ":${PATH-}:" in',
    '    *":${kortix_path_dir}:"*) ;;',
    '    *) kortix_path_prefix="${kortix_path_prefix}${kortix_path_dir}:" ;;',
    '  esac',
    'done',
    'if [ -n "${PATH-}" ]; then PATH="${kortix_path_prefix}${PATH}"; else PATH="${kortix_path_prefix%:}"; fi',
    'export PATH',
    'unset kortix_path_prefix kortix_path_dir',
    '# Live project secrets, written by the kortix-agent daemon on tmpfs.',
    `if [ -r ${KORTIX_AGENT_ENV_FILE} ]; then . ${KORTIX_AGENT_ENV_FILE}; fi`,
    '',
  ].join('\n');
}

/**
 * The Dockerfile RUN step that installs `kortixShellProfileScript` at
 * `KORTIX_SHELL_PROFILE_PATH` and sources it from /etc/bash.bashrc, so login
 * shells (the web terminal) and non-login interactive shells both get it.
 * Must run as root. The bashrc line is appended once, even when the step runs
 * on an image that already has it.
 */
export function kortixShellProfileRun(): string {
  const bashrcLine = `if [ -r ${KORTIX_SHELL_PROFILE_PATH} ]; then . ${KORTIX_SHELL_PROFILE_PATH}; fi`;
  const echoLines = kortixShellProfileScript()
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `      echo '${line}'; \\`);
  return [
    'RUN { \\',
    ...echoLines,
    `    } > ${KORTIX_SHELL_PROFILE_PATH} \\`,
    `    && chmod 0644 ${KORTIX_SHELL_PROFILE_PATH} \\`,
    `    && { grep -qxF '${bashrcLine}' /etc/bash.bashrc 2>/dev/null \\`,
    `         || echo '${bashrcLine}' >> /etc/bash.bashrc; }`,
  ].join('\n');
}

/** pi's global agent dir in the image; the daemon's KORTIX_PI_AGENT_DIR default. */
export const PI_AGENT_DIR = '/opt/kortix/pi-agent';

/**
 * Install the pi system packages the way `pi install` installs a global one:
 * the packages under `<agentDir>/npm`, the sources in `<agentDir>/settings.json`.
 * npm installs required peers, as pi's own install does; the packages pi
 * supplies itself resolve to an empty stub. Install scripts do not run. An
 * empty list adds no layer.
 */
export function piSystemPackageLines(packages: readonly string[]): string[] {
  if (packages.length === 0) return [];
  for (const source of packages) assertPiSystemPackage(source);
  const dependencies: Record<string, string> = Object.fromEntries(PI_SUPPLIED_PACKAGES.map((name) => [name, 'file:./pi-supplied']));
  for (const source of packages) {
    const spec = source.slice('npm:'.length);
    const at = spec.lastIndexOf('@');
    dependencies[spec.slice(0, at)] = spec.slice(at + 1);
  }
  return [
    `RUN mkdir -p ${PI_AGENT_DIR}/npm/pi-supplied \\`,
    `    && printf '%s' '{"name":"kortix-pi-supplied","version":"0.0.0","private":true}' > ${PI_AGENT_DIR}/npm/pi-supplied/package.json \\`,
    `    && printf '%s' '${JSON.stringify({ name: 'kortix-pi-system-packages', private: true, dependencies })}' > ${PI_AGENT_DIR}/npm/package.json \\`,
    `    && npm install --prefix ${PI_AGENT_DIR}/npm --omit=dev --ignore-scripts --no-audit --no-fund \\`,
    `    && printf '%s' '${JSON.stringify({ packages })}' > ${PI_AGENT_DIR}/settings.json`,
    '',
  ];
}

/**
 * Warm jiti's cache for the system packages with the daemon itself (it lands in
 * `<agentDir>/cache/jiti`; each boot copies it in). A package that fails to
 * load fails the image build here, not in a session.
 */
export function piSystemPackageWarmLines(packages: readonly string[]): string[] {
  if (packages.length === 0) return [];
  return ['RUN /usr/local/bin/kortix-agent warm-pi-packages', ''];
}

/**
 * The defaults' network half. Renders against an EMPTY build context and ends
 * as `USER kortix` with a trailing newline, so an image's own tooling or
 * `kortixDefaultsTail` concatenates directly onto it.
 */
export function kortixDefaultsSetup(): string {
  return [
    '# ─── Kortix defaults: every Kortix sandbox image (defaults.ts) ───',
    'USER root',
    // apt is non-interactive by construction here (no TTY), but a package with a
    // debconf prompt (tzdata, libreoffice's font EULAs) can still stall or fail
    // the build. ubuntu:24.04 doesn't set this, so set it ourselves. It persists
    // to runtime deliberately: the agent's own `apt-get install` in a session has
    // no TTY either, and a debconf prompt there is an unrecoverable hang.
    'ENV DEBIAN_FRONTEND=noninteractive',
    // tmux: lets the agent run long-running processes (dev servers for preview)
    // in a detached session that survives the agent's bash tool call.
    // iproute2 (`ip`) + iputils-arping are REQUIRED on Platinum: a
    // snapshot-restored VM keeps its snapshot-baked IP until the host's
    // reconfigure_net runs `ip addr flush/add` + a gratuitous `arping` inside the
    // guest. Without these the guest stays on the baked IP while the edge routes
    // to the allocated IP, and every request 502s.
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git gzip libatomic1 sudo tmux iproute2 iputils-arping util-linux \\',
    // The shell tool floor (rg, fd, bat, jq, fzf, …). See shell-tools.ts for
    // the base-portability rule.
    `        ${SANDBOX_SHELL_TOOL_APT_LIST} \\`,
    '    && rm -rf /var/lib/apt/lists/* \\',
    `    && ${SANDBOX_SHELL_TOOL_LINK_COMMAND}`,
    '',
    'RUN useradd --create-home --shell /bin/bash --user-group kortix \\',
    // E2B's Dockerfile parser removes the backslash from a quoted `\\n`.
    // Use echo so every provider writes the same valid sudoers line.
    "    && echo 'kortix ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kortix \\",
    '    && chmod 0440 /etc/sudoers.d/kortix \\',
    '    && mkdir -p /workspace /opt/kortix \\',
    '        /home/kortix/.local/bin /home/kortix/.local/share/pnpm/bin /home/kortix/.bun/bin \\',
    '    && chown -R kortix:kortix /workspace /opt/kortix /home/kortix',
    'ENV PNPM_HOME=/home/kortix/.local/share/pnpm \\',
    `    PATH=${KORTIX_USER_PATH_DIRS}:$PATH \\`,
    '    SHELL=/bin/bash',
    'USER kortix',
    '',
    // One exact managed Python, exposed as python/python3. Agents use
    // `uv run --with` for dependencies instead of sharing a global venv.
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
    // pnpm's versioned standalone release artifact, after verifying the
    // repository-controlled checksum; the public installer script is not part
    // of the trust path. pnpm then owns the JavaScript runtime floor: Node comes
    // from `pnpm runtime`, npm and global CLIs live in pnpm's global store.
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
    // Bun runs the Slack CLI shims and other agent CLIs. One versioned release
    // artifact, checksum-verified; the public installer script is not part of
    // the trust path.
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
    ...piSystemPackageLines(PI_SYSTEM_PACKAGES),
  ].join('\n') + '\n';
}

/**
 * Inputs for the defaults' staged half — Kortix's own build outputs the
 * builder places in the build context.
 *
 * Every path is REQUIRED, deliberately: an image missing one would still build,
 * still hash to a fresh snapshot identity, and only fail once a session used
 * it. Callers that legitimately stage nothing render `kortixDefaultsSetup`
 * alone — "no artifacts" is a different call, not a forgotten field.
 */
export interface KortixArtifactLayerOpts {
  /** Build-context path of the gzipped kortix-agent binary. */
  agentBinaryPath: string;
  /**
   * Build-context path of the gzipped `kortix` CLI binary — the admin CLI
   * every in-sandbox agent reaches for (`kortix cr open`, `secrets`,
   * `sessions`, …). It lands on PATH as `/usr/local/bin/kortix`,
   * pre-authenticated via the injected KORTIX_TOKEN.
   */
  cliBinaryPath: string;
  /** Build-context path of the entrypoint script. */
  entrypointScriptPath: string;
  /** Build-context path of the platform-managed machine guide, copied to `/MACHINE.md`. */
  machineDocPath: string;
  /**
   * Build-context path of the slack-cli source tree (apps/sandbox/slack-cli).
   * Copied to /opt/kortix/apps/sandbox/slack-cli; install-shims.sh wires each
   * *.ts (excluding lib/) as a /usr/local/bin/<name> shim — that's how `slack`
   * lands on PATH.
   */
  slackCliPath: string;
  /**
   * Build-context path of the staged managed `kortix-*` skill overlay, baked
   * at {@link SANDBOX_MANAGED_SKILLS_DIR}. Without it a box downloads the whole
   * overlay on its first reconcile.
   */
  managedSkillsPath: string;
}

/**
 * The defaults' staged half: the COPYs of Kortix's own build outputs (agent +
 * CLI binaries, entrypoint, machine guide, slack-cli, scaffold.git, managed
 * skills), the unpack RUN that puts them on PATH, the shell profile, and the
 * container's ENV/WORKDIR/EXPOSE/ENTRYPOINT. Every path must exist in the
 * build context.
 */
export function kortixDefaultsTail(opts: KortixArtifactLayerOpts): string {
  const {
    agentBinaryPath,
    cliBinaryPath,
    entrypointScriptPath,
    machineDocPath,
    slackCliPath,
    managedSkillsPath,
  } = opts;

  return [
    'USER root',
    `COPY ${agentBinaryPath} /tmp/kortix-agent.gz`,
    `COPY ${cliBinaryPath} /tmp/kortix.gz`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    `COPY ${machineDocPath} /MACHINE.md`,
    // The channel shims delegate Connector calls to the compiled `kortix` CLI.
    `COPY ${slackCliPath}/ /opt/kortix/apps/sandbox/slack-cli/`,
    // Canonical scaffold repo (bare). Its root commit matches every seeded
    // project's root (pinned dates, seed.ts), enabling local-clone +
    // delta-fetch repo materialization in the daemon (git.ts).
    `COPY scaffold.git /opt/kortix/scaffold.git`,
    'RUN gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\',
    '    && gunzip -c /tmp/kortix.gz > /usr/local/bin/kortix \\',
    '    && rm /tmp/kortix-agent.gz /tmp/kortix.gz \\',
    '    && bash -n /usr/local/bin/kortix-entrypoint \\',
    // 0755, not +x: a build context staged under umask 007 (a PTXP box) copies the
    // entrypoint as 0770, and +x left the `kortix` user unable to read it.
    '    && chmod 0755 /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \\',
    // Fail the build loudly if the CLI didn't land — every sandbox must ship it.
    '    && kortix --version \\',
    // The daemon converges this file in place and runs as `kortix`, so it needs
    // the DIRECTORY. See platform-binaries.ts — asserted on every image.
    `    && ${SANDBOX_CLI_OWNERSHIP_COMMAND} \\`,
    '    && chown -R kortix:kortix /opt/kortix /workspace',
    '',
    // The overlay arrives ALREADY kortix-owned, below the `chown -R` above: a
    // recursive chown in a later layer rewrites every inode it touches and
    // forces overlayfs to copy the whole tree up again (see platform-binaries.ts).
    `COPY --chown=kortix:kortix ${managedSkillsPath} ${SANDBOX_MANAGED_SKILLS_DIR}`,
    // Then state what this image carries, with the daemon that is now on disk.
    // Only the ~500 B bookkeeping file is chowned here, and the daemon must be
    // able to REWRITE it in place: `writeState` writes the path, it does not
    // rename into the directory.
    `RUN ${SANDBOX_RUNTIME_ASSETS_STATE_COMMAND} \\`,
    `    && chown kortix:kortix ${SANDBOX_RUNTIME_ASSETS_STATE_PATH}`,
    '',
    // Web-terminal login shells: keep the Kortix tool dirs on PATH on Debian
    // bases and load project secrets. Written here, still as root, and in the
    // staged tail so it sits below an image's network tooling and never moves
    // that tooling's build-cache key. See kortixShellProfileScript.
    kortixShellProfileRun(),
    '',
    // The daemon clones the project workspace at boot using KORTIX_PROJECT_AUTO_CLONE
    // — nothing project-specific is baked into the image. /workspace is created
    // empty here; the daemon's materializeRepo path fills it.
    'ENV KORTIX_WORKSPACE=/workspace',
    'USER kortix',
    ...piSystemPackageWarmLines(PI_SYSTEM_PACKAGES),
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ].join('\n');
}
