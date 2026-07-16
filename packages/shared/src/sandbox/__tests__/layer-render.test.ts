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
import { describe, expect, test } from 'bun:test';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '../../runtime-versions';
import {
  buildLayeredDockerfile,
  type BuildLayeredDockerfileOpts,
  kortixToolchainLayer,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
} from '../dockerfile-layer';

const COMMON = {
  opencodeVersion: OPENCODE_VERSION,
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  slackCliPath: 'kortix-slack-cli',
  executorSdkPath: 'kortix-executor-sdk',
  opencodeConfigPath: 'kortix-opencode-config',
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

describe('the Python floor is venv-isolated from dpkg', () => {
  const toolchain = kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION });

  test('never lets pip write to the system interpreter', () => {
    // The whole dpkg-conflict class in one assertion: pip inside a venv cannot
    // uninstall a dpkg-owned package, so it can never reproduce "Cannot uninstall
    // numpy 1.26.4, RECORD file not found ... installed by debian".
    expect(toolchain).not.toContain('--break-system-packages');
    expect(toolchain).toContain('RUN /opt/kortix/pyfloor/bin/pip install --no-cache-dir \\');
  });

  test('builds the venv from the base image python, not the one apt just added', () => {
    // Risk 1a: on `python:3.12-slim` the apt floor drops Debian's python3 at
    // /usr/bin/python3. Building the venv from THAT (then PATH-shadowing) would
    // downgrade the image's own interpreter. `base_py` is resolved BEFORE apt runs.
    expect(toolchain).toContain('RUN base_py="$(command -v python3 || true)" \\');
    expect(toolchain).toContain(
      '    && "${base_py:-python3}" -m venv --system-site-packages /opt/kortix/pyfloor \\',
    );
    // …and it must be resolved before apt can install a second interpreter.
    expect(toolchain.indexOf('base_py=')).toBeLessThan(toolchain.indexOf('apt-get update'));
  });

  test('--system-site-packages keeps the user own installs importable', () => {
    // Without this the floor's python would lose the user's apt/pip packages
    // (geopandas, fiona, …) — trading a build failure for an import failure.
    expect(toolchain).toContain('-m venv --system-site-packages /opt/kortix/pyfloor');
  });

  test('verifies the import floor through the venv interpreter', () => {
    expect(toolchain).toContain(
      "    && /opt/kortix/pyfloor/bin/python -c 'import importlib;",
    );
  });

  test('extends PATH rather than stomping it', () => {
    // Verified against BuildKit AND buildah's classic imagebuilder: both expand
    // $PATH in ENV from the base image config. A hardcoded absolute PATH here
    // would silently drop a user's cargo/nvm/conda entries.
    expect(toolchain).toContain('ENV PATH=/opt/kortix/pyfloor/bin:$PATH');
  });

  test('sets DEBIAN_FRONTEND itself instead of inheriting it by luck', () => {
    expect(toolchain).toContain('ENV DEBIAN_FRONTEND=noninteractive');
  });
});

describe('the /workspace wipe is scoped to the shared default image', () => {
  const WIPE = 'find /workspace -mindepth 1 -delete';

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
    expect(custom).toContain('[ "$staged_starter_config" = 1 ] && rm -rf /workspace/.kortix/opencode');
  });

  test('a per-project warm keeps the baked checkout (unchanged)', () => {
    const warm = buildLayeredDockerfile(CASES[2]!.opts);
    expect(warm).not.toContain(WIPE);
    expect(warm).toContain('warm-repo: keeping baked /workspace checkout');
  });

  test('warmRepo outranks isSharedDefault — a baked checkout is never wiped', () => {
    const both = buildLayeredDockerfile({ ...CASES[2]!.opts, isSharedDefault: true });
    expect(both).not.toContain(WIPE);
  });
});
