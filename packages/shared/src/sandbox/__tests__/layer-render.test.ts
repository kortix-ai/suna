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
import {
  AGENT_BROWSER_VERSION,
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PYTHON_PACKAGE_FLOOR,
  PYTHON_PACKAGE_FLOOR_IMPORTS,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
} from '../../runtime-versions';
import {
  type BuildLayeredDockerfileOpts,
  KORTIX_USER_PATH_DIRS,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
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

/** The two shapes the production builder actually renders. */
const CASES: Array<{ label: string; opts: BuildLayeredDockerfileOpts }> = [
  {
    label: 'shared platform default',
    opts: { userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, isSharedDefault: true, ...COMMON },
  },
  {
    label: 'custom template (user seeds /workspace)',
    opts: { userDockerfile: GDAL_USER_DOCKERFILE, ...COMMON },
  },
];

describe('rendered layer (golden)', () => {
  for (const { label, opts } of CASES) {
    test(label, () => {
      expect(buildLayeredDockerfile(opts)).toMatchSnapshot();
    });
  }
});

describe('runtime artifact integrity', () => {
  const rendered = kortixToolchainLayer(COMMON);

  test('verifies both supported architectures against repository-controlled SHA-256 digests', () => {
    for (const digest of [
      PNPM_SHA256_AMD64,
      PNPM_SHA256_ARM64,
      UV_SHA256_AMD64,
      UV_SHA256_ARM64,
      BUN_SHA256_AMD64,
      BUN_SHA256_ARM64,
    ]) {
      expect(rendered).toContain(digest);
    }
    expect(rendered.match(/sha256sum -c -/g)).toHaveLength(3);
  });

  test('does not execute remote installer scripts', () => {
    expect(rendered).not.toContain('get.pnpm.io/install.sh');
    expect(rendered).not.toContain('astral.sh/uv/');
    expect(rendered).not.toContain('bun.com/install');
    expect(rendered).not.toMatch(/curl[^|\n]*\|\s*(?:sh|bash)/);
  });

  test('fails the image build when OpenCode warm-up fails', () => {
    expect(rendered).toContain(
      'RUN bash /tmp/kortix-opencode-warmup migration && rm -f /tmp/kortix-opencode-warmup',
    );
    expect(rendered).not.toContain('kortix-opencode-warmup migration; rm -f');

    for (const { opts } of CASES) {
      const image = buildLayeredDockerfile(opts);
      expect(image).toMatch(
        /RUN bash \/tmp\/kortix-opencode-warmup instance (?:keep|repo|wipe|targeted) && rm -f \/tmp\/kortix-opencode-warmup/,
      );
      expect(image).not.toMatch(/kortix-opencode-warmup instance \w+; rm -f/);
    }
  });

  test('exposes the native OpenCode executable at the supervisor path', () => {
    expect(rendered).toContain(
      "opencode_native=\"$(sed -n 's/^# cmd-shim-target=//p' \"$(command -v opencode)\" | tail -n 1)\"",
    );
    expect(rendered).not.toContain('pnpm list -g');
    expect(rendered).not.toContain('pnpm root -g');
    expect(rendered).toContain('test "$(wc -c < "$opencode_native")" -gt 50000000');
    expect(rendered).toContain('ln -sfn "$opencode_native" /opt/kortix/opencode.current');
    expect(rendered).toContain(
      'sudo ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix',
    );
    expect(rendered).not.toContain(
      'ln -sfn "$opencode_native" /usr/local/bin/opencode-kortix',
    );
    expect(rendered).toContain('/usr/local/bin/opencode-kortix --version');
  });
});

describe('the Python runtime is managed by uv', () => {
  const toolchain = kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION });

  test('does not install or mutate the distro Python', () => {
    expect(toolchain).not.toContain('python3 python3-dev python3-pip python3-venv');
    expect(toolchain.match(/uv pip install/g)).toHaveLength(1);
    expect(toolchain).toContain(
      'uv pip install --python /home/kortix/.local/bin/python3 --break-system-packages',
    );
    expect(toolchain).not.toContain('uv pip install --system');
  });

  test('bakes every floor package exactly-pinned into the managed Python', () => {
    for (const [pkg, version] of Object.entries(PYTHON_PACKAGE_FLOOR)) {
      expect(toolchain).toContain(`"${pkg}==${version}"`);
    }
  });

  test('proves every floor import at build time in a single-line check', () => {
    for (const importName of Object.values(PYTHON_PACKAGE_FLOOR_IMPORTS)) {
      expect(toolchain).toContain(`"${importName}"`);
    }
    expect(toolchain).toContain('python package floor OK');
    expect(toolchain).not.toContain('<<');
  });

  test('every floor package has an import mapping and vice versa', () => {
    expect(Object.keys(PYTHON_PACKAGE_FLOOR_IMPORTS).sort()).toEqual(
      Object.keys(PYTHON_PACKAGE_FLOOR).sort(),
    );
  });

  test('python-playwright matches the Node playwright that bakes Chromium', () => {
    expect(PYTHON_PACKAGE_FLOOR.playwright).toBe(PLAYWRIGHT_VERSION);
  });

  test('installs an exact managed Python as python and python3', () => {
    expect(toolchain).toContain(
      'UV_PYTHON_DOWNLOADS=automatic uv python install --default 3.12.13',
    );
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
  const chromiumAt = (t: string) => t.indexOf('pnpm dlx playwright@');
  const opencodeInstallAt = (t: string) => t.indexOf('"opencode-ai@');
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
    // prod, so this used to be the wipe path for every custom image.
    const custom = buildLayeredDockerfile({ userDockerfile: GDAL_USER_DOCKERFILE, ...COMMON });
    expect(custom).not.toContain(WIPE);
    // It still cleans up after ITSELF — only the config it staged, and only if it
    // was the one that staged it.
    expect(custom).toContain('kortix-opencode-warmup instance targeted');
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
    // -E, because sudo's default env_reset drops every KORTIX_* var and the
    // daemon would come up with no session identity while still passing its
    // health check. Verified against this image's own sudoers line
    // ('kortix ALL=(ALL) NOPASSWD:ALL'): as root, -E is accepted without a
    // SETENV tag, and without it the token arrives empty.
    expect(entrypoint).toContain('sudo -E -u kortix --');
  });

  test('entrypoint PATH dirs cannot drift from the toolchain ENV PATH', () => {
    expect(rendered).toContain(`PATH=${KORTIX_USER_PATH_DIRS}:$PATH`);
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

  test('compiled boot verifies server.mjs before launch and preserves prefer fallback', () => {
    expect(entrypoint).toContain('install-compiled-runtime')
    expect(entrypoint).toContain('node "${COMPILED_RUNTIME_PATH}"')
    expect(entrypoint).toContain('compiled runtime is required but unavailable')
    expect(entrypoint).toContain('compiled runtime rejected launch; falling back to baked agent')
  });

  test('build verifies entrypoint syntax before wiring it as the entrypoint', () => {
    expect(rendered).toContain('&& bash -n /usr/local/bin/kortix-entrypoint');
  });
});
