/**
 * Golden + invariant tests over the RENDERED layer text.
 *
 * Why a golden: the rendered Dockerfile is not hashed into snapshot identity (it
 * enters only via RUNTIME_LAYER_VERSION in apps/api/src/snapshots/templates.ts),
 * it is never executed in CI, and its failures land minutes later inside a remote
 * provider build. So the text is effectively unreviewed — a
 * `find /workspace -mindepth 1 -delete` sat inside a `set +e … true` block,
 * silently wiping /workspace for every custom template, and nothing caught it.
 * layer-split.test.ts pins that the two halves CONCATENATE correctly, and
 * apps/api's unit-dockerfile-layer.test.ts spot-checks individual substrings;
 * neither makes the whole emitted script reviewable as a diff. This does: any
 * change to the layer shows up here as an explicit before/after, so `bun test -u`
 * is the moment you notice you also need the RUNTIME_LAYER_VERSION bump.
 *
 * The `test`s below the golden pin the invariants that a snapshot update could
 * otherwise wave through.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '../../runtime-versions';
import {
  type BuildLayeredDockerfileOpts,
  KORTIX_USER_PATH_DIRS,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
  buildPerProjectWarmFromBaseDockerfile,
  kortixToolchainLayer,
} from '../dockerfile-layer';

const COMMON = {
  opencodeVersion: OPENCODE_VERSION,
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  executorSdkPath: 'kortix-executor-sdk',
  opencodeConfigPath: 'kortix-opencode-config',
  opencodeWarmupScriptPath: 'kortix-opencode-warmup',
  catalogPath: 'kortix-llm-catalog.json',
};

/**
 * A custom template that seeds /workspace — the shape the wipe used to destroy.
 * `gdal-bin` is the real incident: it pulls python3-gdal → dpkg-owned
 * python3-numpy, which the old `pip install --break-system-packages` floor then
 * tried to uninstall, hard-failing the build on a perfectly correct image.
 */
const GDAL_USER_DOCKERFILE = `FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin

WORKDIR /workspace
RUN mkdir -p /workspace/data && echo seed > /workspace/data/basemap.tif
`;

/** The three shapes the production builder actually renders. */
const CASES: Array<{ label: string; opts: BuildLayeredDockerfileOpts }> = [
  {
    label: 'shared platform default',
    opts: { userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, isSharedDefault: true, ...COMMON },
  },
  {
    label: 'custom template (user seeds /workspace)',
    opts: { userDockerfile: GDAL_USER_DOCKERFILE, ...COMMON },
  },
  {
    label: 'per-project cold warm (warmRepo)',
    opts: {
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      ...COMMON,
      warmRepo: {
        cloneUrl: 'https://git.example.com/acme/app.git',
        cloneHeaders: { Authorization: 'Bearer redacted' },
        branch: 'main',
        originUrl: 'https://kortix.example.com/v1/git/proj.git',
      },
    },
  },
];

describe('rendered layer (golden)', () => {
  for (const { label, opts } of CASES) {
    test(label, () => {
      expect(buildLayeredDockerfile(opts)).toMatchSnapshot();
    });
  }
});

describe('the Python runtime is managed by uv', () => {
  const toolchain = kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION });

  test('does not install or mutate the distro Python', () => {
    expect(toolchain).not.toContain('python3 python3-dev python3-pip python3-venv');
    expect(toolchain).not.toContain('--break-system-packages');
    expect(toolchain).not.toContain('uv pip install');
  });

  test('installs an exact managed Python as python and python3', () => {
    expect(toolchain).toContain('UV_PYTHON_DOWNLOADS=automatic uv python install --default 3.12.13');
    expect(toolchain).toContain('assert sys.version_info[:3] == (3, 12, 13)');
    expect(toolchain).toContain("&& python3 -c 'import sys;");
  });

  test('extends PATH rather than stomping it', () => {
    // Verified against BuildKit AND buildah's classic imagebuilder: both expand
    // $PATH in ENV from the base image config. A hardcoded absolute PATH here
    // would silently drop a user's cargo/nvm/conda entries.
    expect(toolchain).toContain('/home/kortix/.local/bin');
    expect(toolchain).not.toContain('/home/kortix/.venv/bin');
  });

  test('sets DEBIAN_FRONTEND itself instead of inheriting it by luck', () => {
    expect(toolchain).toContain('ENV DEBIAN_FRONTEND=noninteractive');
  });
});

describe('Chromium sits on deterministic parents (cache order is load-bearing)', () => {
  // Regression guard for the v0.10.11 "session never starts" incident. The
  // provider build caches are CONTENT-ADDRESSED (Daytona has no instruction-text
  // cache, no agent-swap), so a non-deterministic layer above the ~150MB Chromium
  // download busts its cache and forces a re-download on every rebuild. An
  // agent-server code change re-mints the base snapshot hash → a full Daytona
  // rebuild → if Chromium sat below the `opencode serve` migration-bake (sqlite
  // with live timestamps) or the warm-repo clone (fresh credential in the RUN
  // text), it re-downloaded and overran the session-ready window. Chromium must
  // stay directly on the deterministic apt + pip floors, ABOVE all of them.
  const chromiumAt = (t: string) =>
    t.indexOf('pnpm dlx playwright@');
  const opencodeInstallAt = (t: string) =>
    t.indexOf('"opencode-ai@');
  const migrationBakeAt = (t: string) => t.indexOf('kortix-opencode-warmup migration');

  test('the base default image installs Chromium before opencode + the migration-bake', () => {
    const base = kortixToolchainLayer({
      opencodeVersion: OPENCODE_VERSION,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      opencodeConfigPath: 'kortix-opencode-config',
      opencodeWarmupScriptPath: 'kortix-opencode-warmup',
      isSharedDefault: true,
    });
    const chromium = chromiumAt(base);
    expect(chromium).toBeGreaterThan(-1);
    expect(chromium).toBeLessThan(opencodeInstallAt(base));
    expect(chromium).toBeLessThan(migrationBakeAt(base));
  });

  test('a per-project warm bake installs Chromium before the credential-bearing clone', () => {
    const warm = kortixToolchainLayer({
      opencodeVersion: OPENCODE_VERSION,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      opencodeConfigPath: 'kortix-opencode-config',
      opencodeWarmupScriptPath: 'kortix-opencode-warmup',
      warmRepo: {
        cloneUrl: 'https://git.example.com/acme/app.git',
        cloneHeaders: { Authorization: 'Bearer redacted' },
        branch: 'main',
        originUrl: 'https://kortix.example.com/v1/git/proj.git',
      },
    });
    const chromium = chromiumAt(warm);
    expect(chromium).toBeGreaterThan(-1);
    // the credential-bearing clone RUN must come strictly after Chromium
    expect(chromium).toBeLessThan(warm.indexOf('/tmp/kortix-warm-repo'));
  });
});

describe('the /workspace cleanup is scoped to the shared default image', () => {
  const WIPE = 'kortix-opencode-warmup instance wipe';

  test('the shared default wipes (it owns /workspace)', () => {
    const shared = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      isSharedDefault: true,
      ...COMMON,
    });
    expect(shared).toContain(WIPE);
  });

  test('a custom template does NOT wipe — the user Dockerfile owns /workspace', () => {
    // The regression this whole fix exists for: opencodeConfigPath is ALWAYS set in
    // prod and warmRepo is unset for a normal custom template, so this used to be
    // the wipe path for every custom image.
    const custom = buildLayeredDockerfile({ userDockerfile: GDAL_USER_DOCKERFILE, ...COMMON });
    expect(custom).not.toContain(WIPE);
    // It still cleans up after ITSELF — only the config it staged, and only if it
    // was the one that staged it.
    expect(custom).toContain('kortix-opencode-warmup instance targeted');
  });

  test('a per-project warm keeps the baked checkout (unchanged)', () => {
    const warm = buildLayeredDockerfile(CASES[2]!.opts);
    expect(warm).not.toContain(WIPE);
    expect(warm).toContain('kortix-opencode-warmup instance keep');
  });

  test('warmRepo outranks isSharedDefault — a baked checkout is never wiped', () => {
    const both = buildLayeredDockerfile({ ...CASES[2]!.opts, isSharedDefault: true });
    expect(both).not.toContain(WIPE);
  });
});

describe('the entrypoint survives providers that discard image USER/ENV', () => {
  const rendered = buildLayeredDockerfile(CASES[0]!.opts);
  const entrypoint = readFileSync(
    resolve(import.meta.dir, '../../../../../apps/sandbox/entrypoint.sh'),
    'utf8',
  );

  test('stages one script and wires it as the entrypoint', () => {
    expect(rendered).toContain('COPY kortix-entrypoint /usr/local/bin/kortix-entrypoint');
    expect(rendered).not.toContain('kortix-entrypoint-real');
    expect(rendered).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
  });

  test('restores the kortix PATH dirs and drops root to kortix with HOME restored', () => {
    expect(entrypoint).toContain(`KORTIX_PATH="${KORTIX_USER_PATH_DIRS}"`);
    expect(entrypoint).toContain('export HOME=/home/kortix USER=kortix LOGNAME=kortix');
    expect(entrypoint).toContain('setpriv --reuid kortix --regid kortix --init-groups');
    expect(entrypoint).toContain('sudo -u kortix --');
  });

  test('entrypoint PATH dirs cannot drift from the toolchain ENV PATH', () => {
    expect(rendered).toContain(`ENV PATH=${KORTIX_USER_PATH_DIRS}:$PATH`);
  });

  test('carries ONLY the two temporary Platinum mitigations, before the privilege drop, each best-effort', () => {
    const dropAt = entrypoint.indexOf('setpriv --reuid kortix');
    const mitigations = [
      'mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm',
      'ulimit -Hn 1048576',
      'ulimit -Sn 1048576',
    ];
    for (const m of mitigations) {
      const at = entrypoint.indexOf(m);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(dropAt);
    }
    expect(entrypoint).toContain('chmod 1777 /dev/shm 2>/dev/null || true');
    expect(entrypoint).toContain('ulimit -Hn 1048576 2>/dev/null || true');
    expect(entrypoint).toContain('ulimit -Sn 1048576 2>/dev/null || true');
    expect(entrypoint).not.toContain('machine-id');
    expect(entrypoint).not.toContain('/etc/hosts');
    expect(entrypoint).not.toContain('/dev/stdin');
    expect(entrypoint).not.toContain('LANG');
  });

  test('the staged entrypoint is valid bash', () => {
    const proc = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(entrypoint), stderr: 'pipe' });
    expect(proc.exitCode).toBe(0);
  });

  test('build verifies entrypoint syntax before wiring it as the entrypoint', () => {
    expect(rendered).toContain('&& bash -n /usr/local/bin/kortix-entrypoint');
  });
});

describe('buildPerProjectWarmFromBaseDockerfile (FROM-base fast path)', () => {
  const FROM_BASE_OPTS = {
    baseImageRef: 'registry.daytona.internal/kortix-default-abc123:latest',
    opencodeConfigPath: 'kortix-opencode-config',
    opencodeWarmupScriptPath: 'kortix-opencode-warmup',
    warmRepo: {
      cloneUrl: 'https://git.example.com/acme/app.git',
      cloneHeaders: { Authorization: 'Bearer redacted' },
      branch: 'main',
      originUrl: 'https://kortix.example.com/v1/git/proj.git',
    },
  };

  test('golden', () => {
    expect(buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS)).toMatchSnapshot();
  });

  test('FROMs the base image ref as the very first line', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    expect(rendered.startsWith(`FROM ${FROM_BASE_OPTS.baseImageRef}\n`)).toBe(true);
  });

  test('never re-installs the toolchain — Chromium is inherited, not re-run', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    expect(rendered).not.toContain('apt-get');
    expect(rendered).not.toContain('opencode-ai@');
    expect(rendered).not.toContain('playwright');
    expect(rendered).not.toContain('chromium');
    expect(rendered).not.toContain('agent-browser@');
    expect(rendered).not.toContain('pip install');
    expect(rendered).not.toContain('bun.com/install');
  });

  test('bakes the repo checkout and re-warms the opencode instance against it', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    expect(rendered).toContain('Per-project COLD warm: bake repo checkout into /workspace');
    expect(rendered).toContain(FROM_BASE_OPTS.warmRepo.cloneUrl);
    expect(rendered).toContain('RUN bash /tmp/kortix-opencode-warmup instance keep; rm -f /tmp/kortix-opencode-warmup');
  });

  test('renders the clone + warm-up steps byte-identically to the monolithic build', () => {
    const monolithic = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      ...COMMON,
      warmRepo: FROM_BASE_OPTS.warmRepo,
    });
    const fromBase = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    const startMarker = 'RUN cd / \\\n    && rm -rf /tmp/kortix-warm-repo';
    const endMarker = 'rm -f /tmp/kortix-opencode-warmup';
    const slice = (text: string) =>
      text.slice(text.indexOf(startMarker), text.lastIndexOf(endMarker) + endMarker.length);
    expect(slice(fromBase)).toBe(slice(monolithic));
  });

  test('does not COPY or reference any staged artifact paths — everything is inherited', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    expect(rendered).not.toContain('COPY kortix-agent.gz');
    expect(rendered).not.toContain('COPY kortix.gz');
    expect(rendered).not.toContain('scaffold.git');
    expect(rendered).not.toContain('ENTRYPOINT');
  });

  test('with no opencodeConfigPath, only the clone step is added on top of the base', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile({
      baseImageRef: FROM_BASE_OPTS.baseImageRef,
      warmRepo: FROM_BASE_OPTS.warmRepo,
    });
    expect(rendered).not.toContain('COPY ');
    expect(rendered).toContain('Per-project COLD warm: bake repo checkout into /workspace');
  });

  test('is portable — no buildah-unsupported heredocs', () => {
    const rendered = buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS);
    const heredocLine = rendered
      .split('\n')
      .find((l) => !/^\s*#/.test(l) && /<<-?['"]?[A-Za-z_]\w*['"]?\s*\\?\s*$/.test(l));
    expect(heredocLine).toBeUndefined();
  });

  test('result ends with a trailing newline', () => {
    expect(buildPerProjectWarmFromBaseDockerfile(FROM_BASE_OPTS).endsWith('\n')).toBe(true);
  });
});
