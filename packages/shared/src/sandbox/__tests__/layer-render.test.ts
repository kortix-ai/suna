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
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PYTHON_PACKAGE_FLOOR,
  PYTHON_PACKAGE_FLOOR_IMPORTS,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
  VOXL_SHA256_AMD64,
  VOXL_SHA256_ARM64,
} from '../../runtime-versions';
import {
  type BuildLayeredDockerfileOpts,
  KORTIX_USER_PATH_DIRS,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
  kortixToolchainLayer,
} from '../dockerfile-layer';

const COMMON = {
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  managedSkillsPath: 'managed-skills',
};

/**
 * A custom template that seeds /workspace.
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
    opts: { userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, ...COMMON },
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
      VOXL_SHA256_AMD64,
      VOXL_SHA256_ARM64,
    ]) {
      expect(rendered).toContain(digest);
    }
    expect(rendered.match(/sha256sum -c -/g)).toHaveLength(4);
  });

  test('does not execute remote installer scripts', () => {
    expect(rendered).not.toContain('get.pnpm.io/install.sh');
    expect(rendered).not.toContain('astral.sh/uv/');
    expect(rendered).not.toContain('bun.com/install');
    expect(rendered).not.toMatch(/curl[^|\n]*\|\s*(?:sh|bash)\b/);
  });
});

describe('the Python runtime is managed by uv', () => {
  const toolchain = kortixToolchainLayer({});

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

  test('carries ONLY the three temporary Platinum mitigations, before the privilege drop, each best-effort', () => {
    const dropAt = entrypoint.indexOf('setpriv --reuid kortix');
    const mitigations = [
      'mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm',
      'chmod 644 /etc/hosts',
      'ulimit -Hn 1048576',
      'ulimit -Sn 1048576',
    ];
    for (const m of mitigations) {
      const at = entrypoint.indexOf(m);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(dropAt);
    }
    expect(entrypoint).toContain('chmod 1777 /dev/shm 2>/dev/null || true');
    expect(entrypoint).toContain('chmod 644 /etc/hosts 2>/dev/null || true');
    expect(entrypoint).toContain('ulimit -Hn 1048576 2>/dev/null || true');
    expect(entrypoint).toContain('ulimit -Sn 1048576 2>/dev/null || true');
    expect(entrypoint).not.toContain('machine-id');
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
