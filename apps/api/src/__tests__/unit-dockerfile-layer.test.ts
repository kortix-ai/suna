import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_BROWSER_VERSION,
  BUN_SHA256_AMD64,
  BUN_VERSION,
  NODE_VERSION,
  NPM_VERSION,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_VERSION,
  UV_SHA256_AMD64,
  UV_VERSION,
} from '@kortix/shared';
import {
  DEFAULT_SANDBOX_SLUG,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  SANDBOX_SPEC_LIMITS,
  buildDefaultSandboxTemplate,
  buildLayeredDockerfile,
  extractSandboxDefault,
  extractSandboxTemplates,
} from '../snapshots/dockerfile-layer';

const COMMON = {
  opencodeVersion: OPENCODE_VERSION,
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  executorSdkPath: 'kortix-executor-sdk',
  opencodeWarmupScriptPath: 'kortix-opencode-warmup',
};

describe('buildLayeredDockerfile', () => {
  test('installs the runtime floor from pinned, checksum-verified release artifacts', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    expect(merged).not.toContain('ca-certificates curl git gzip nodejs npm unzip');
    expect(merged).toContain('USER kortix');
    expect(merged).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(merged).toContain('/home/kortix/.local/share/pnpm/bin');
    expect(merged).toContain(
      `https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz`,
    );
    expect(merged).toContain(PNPM_SHA256_AMD64);
    expect(merged).toContain(
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-\${uv_arch}-unknown-linux-gnu.tar.gz`,
    );
    expect(merged).toContain(UV_SHA256_AMD64);
    expect(merged).toContain(`grep -Eq '^uv ${UV_VERSION}( |$)'`);
    expect(merged).not.toContain(`test "$(uv --version)" = "uv ${UV_VERSION}"`);
    expect(merged).toContain(
      `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-\${bun_arch}.zip`,
    );
    expect(merged).toContain(BUN_SHA256_AMD64);
    expect(merged).toContain('sha256sum -c -');
    expect(merged).not.toContain('get.pnpm.io/install.sh');
    expect(merged).not.toContain('astral.sh/uv/');
    expect(merged).not.toContain('bun.com/install');
    expect(merged).toContain(`pnpm runtime set node ${NODE_VERSION} -g`);
    expect(merged).toContain(`test "$(node --version)" = "v${NODE_VERSION}"`);
    expect(merged).toContain(`pnpm add -g "npm@${NPM_VERSION}"`);
    expect(merged).toContain(`test "$(npm --version)" = "${NPM_VERSION}"`);
    expect(merged).toContain(`test "$(bun --version)" = "${BUN_VERSION}"`);
    expect(merged).toContain(
      `pnpm add -g --allow-build=opencode-ai "opencode-ai@${OPENCODE_VERSION}"`,
    );
    expect(merged).toContain(
      `pnpm add -g --allow-build=agent-browser "agent-browser@${AGENT_BROWSER_VERSION}"`,
    );
    expect(merged).not.toContain('npm install -g');
    expect(merged).not.toContain('npx -y');
  });

  test('accepts uv release metadata in the standalone sandbox image', () => {
    const dockerfile = readFileSync(
      resolve(import.meta.dir, '../../../sandbox/Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('grep -Eq "^uv ${UV_VERSION}( |$)"');
    expect(dockerfile).not.toContain('test "$(uv --version)" = "uv ${UV_VERSION}"');
  });

  test('runs build-time and runtime tools as the standard kortix user', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    expect(merged).toContain('useradd --create-home --shell /bin/bash --user-group kortix');
    expect(merged).toContain("printf 'kortix ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/kortix");
    expect(merged).toContain(
      'chown -R kortix:kortix /workspace /opt/kortix /opt/pw-browsers /ephemeral',
    );
    expect(merged).not.toContain('ENV HOME=');
    expect(merged).not.toContain('XDG_DATA_HOME=');
    expect(merged).not.toContain('XDG_CONFIG_HOME=');
    expect(merged).not.toContain('XDG_CACHE_HOME=');
    expect(merged).toContain('USER root\nCOPY kortix-agent.gz');
    expect(merged).toContain('ENV KORTIX_WORKSPACE=/workspace\nUSER kortix\nWORKDIR /workspace');
  });

  test('preserves the user Dockerfile verbatim and appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain(`opencode-ai@${OPENCODE_VERSION}`);
    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
    expect(merged).toContain('uv python install --default 3.12.13');
    expect(merged).not.toContain('uv venv');
    expect(merged).not.toContain('uv pip install');
    expect(merged).toContain('COPY kortix-agent.gz /tmp/kortix-agent.gz');
    expect(merged).toContain('gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent');
    // The admin CLI is baked alongside the daemon and verified at build time.
    expect(merged).toContain('COPY kortix.gz /tmp/kortix.gz');
    expect(merged).toContain('COPY MACHINE.md /MACHINE.md');
    expect(merged).toContain('gunzip -c /tmp/kortix.gz > /usr/local/bin/kortix');
    expect(merged).toContain('kortix --version');
    expect(merged).toContain('COPY kortix-slack-cli/ /opt/kortix/apps/sandbox/slack-cli/');
    expect(merged).toContain('COPY kortix-executor-sdk/ /opt/kortix/packages/executor-sdk/');
    expect(merged).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
  });

  test('bakes a real Chromium for agent-browser and verifies it at build time', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    // Chromium comes from Playwright (cross-arch; Chrome for Testing has no
    // linux-arm64 build) and pulls its OS libs via --with-deps.
    expect(merged).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`);
    // Wired BOTH ways: the documented env var → a stable symlink, AND
    // agent-browser's own auto-detected cache (env-independent, #422-proof).
    expect(merged).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium');
    expect(merged).toContain('/home/kortix/.agent-browser/browsers/chrome-linux64');
    // The build FAILS LOUDLY if Chromium didn't wire up — never install at runtime.
    expect(merged).toContain('chromium --version');
    // Gate matches the resolved PATH (deterministic), not the browser name —
    // doctor says "Chromium" on arm64 but "Google Chrome for Testing" on x64.
    expect(merged).toContain("agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'");
    // PLAYWRIGHT_BROWSERS_PATH must be set BEFORE the install so Chromium lands
    // in the stable system path the symlinks resolve against.
    const envIdx = merged.indexOf('PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers');
    const installIdx = merged.indexOf(`playwright@${PLAYWRIGHT_VERSION} install`);
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(installIdx);
  });

  test('hardens the Chromium download: generous timeout + backoff retry, still fails loudly on total loss', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    // Playwright's default download socket timeout is 30s — too tight for a
    // ~150MB Chrome-for-Testing fetch under any network hiccup. Overridden
    // before the install runs. 30 minutes: headroom for a cold-cache build
    // under contention (the fallback full-rebuild path only — the primary fix
    // is the FROM-base fast path, which never re-runs this install at all).
    expect(merged).toContain('PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=1800000');
    const timeoutIdx = merged.indexOf('PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=1800000');
    const installIdx = merged.indexOf(`playwright@${PLAYWRIGHT_VERSION} install`);
    expect(timeoutIdx).toBeGreaterThanOrEqual(0);
    expect(timeoutIdx).toBeLessThan(installIdx);
    // A 5-attempt backoff loop around the install, portable to buildah's classic
    // imagebuilder (plain sh for/$(( )), no heredoc).
    expect(merged).toContain('for pw_try in 1 2 3 4 5; do');
    expect(merged).toContain('sleep $((pw_try*10));');
    // The loop's own exit status doesn't gate the build — the downstream
    // `test -n "$pw_chrome"` guard still hard-fails it if every attempt failed.
    const pwChromeIdx = merged.indexOf('pw_chrome="$(find /opt/pw-browsers');
    expect(pwChromeIdx).toBeGreaterThan(merged.indexOf('for pw_try in 1 2 3 4 5; do'));
    expect(merged).toContain('&& test -n "$pw_chrome"');
  });

  test('the Chromium layer sits BEFORE the per-project warm-repo COPY', () => {
    // Cache-order invariant: the warm-repo COPY (and, downstream of it, the
    // opencode instance re-warm) is per-project and never cache-stable, so
    // Chromium must sit ahead of it — keeping Chromium's own content-addressed
    // cache key independent of any per-project step and identical across every
    // per-project bake AND the shared default image. (PHASE 1 moved the
    // credential-bearing clone API-side; the image now only COPYs sanitized
    // bytes, but the ordering guarantee is unchanged.)
    const merged = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
      opencodeConfigPath: 'kortix-opencode-config',
      warmRepo: {
        stagedPath: 'kortix-warm-repo',
        stagedGitPath: 'kortix-warm-repo-git',
        branch: 'main',
      },
    });
    const chromiumIdx = merged.indexOf(
      `playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`,
    );
    const cloneIdx = merged.indexOf('Per-project COLD warm: bake repo checkout into /workspace');
    const opencodeWarmupIdx = merged.indexOf('kortix-opencode-warmup instance keep');
    expect(chromiumIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(opencodeWarmupIdx).toBeGreaterThanOrEqual(0);
    expect(chromiumIdx).toBeLessThan(cloneIdx);
    expect(cloneIdx).toBeLessThan(opencodeWarmupIdx);
  });

  test('hard-fails the bake if opencode-config-deps cannot be bundled by Bun', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    // Regression coverage for the incident where `bun install` exited 0 but
    // the installed tree (a CVE-driven axios override) failed to BUNDLE at
    // session runtime, silently baking a broken image. This must be its own
    // RUN step, not folded into a `set +e` block — an unbundlable dependency
    // tree has to fail the image build.
    const verifyIdx = merged.indexOf(
      'bun build node_modules/axios/lib/utils.js node_modules/form-data/lib/form_data.js',
    );
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    const precedingRun = merged.lastIndexOf('RUN', verifyIdx);
    const stepText = merged.slice(precedingRun, verifyIdx);
    expect(stepText).not.toContain('set +e');
    // Must run after the install it's verifying, not before.
    const installIdx = merged.indexOf('bun install');
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeLessThan(verifyIdx);
  });

  test('also verifies the real starter tool files bundle when opencodeConfigPath is provided', () => {
    const withConfig = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
      opencodeConfigPath: 'kortix-opencode-config',
      catalogPath: 'kortix-llm-catalog.json',
    });
    const verifyIdx = withConfig.indexOf('bun build tools/*.ts');
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    const precedingRun = withConfig.lastIndexOf('RUN', verifyIdx);
    const stepText = withConfig.slice(precedingRun, verifyIdx);
    expect(stepText).not.toContain('set +e');
    // Without opencodeConfigPath there's no starter tool tree to verify, so
    // this stricter check is correctly absent — only the axios/form-data
    // override check (always present) still runs.
    const withoutConfig = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
    });
    expect(withoutConfig).not.toContain('bun build tools/*.ts');
    expect(withoutConfig).toContain(
      'bun build node_modules/axios/lib/utils.js node_modules/form-data/lib/form_data.js',
    );
  });

  test('does NOT bake the project workspace into the image', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...COMMON });
    expect(merged).not.toContain('kortix-workspace.tar.gz');
    // The daemon clones at boot via KORTIX_PROJECT_AUTO_CLONE; the layer just
    // creates an empty /workspace.
    expect(merged).toContain('mkdir -p /workspace');
  });

  test('strips only the generated starter baseline apt block', () => {
    const user = `FROM ubuntu:24.04

# Bring in baseline tooling. The Kortix layer on top also installs
# git/curl/ca-certificates/nodejs/npm, but having them in your base
# makes interactive sessions snappier.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
        ca-certificates \\
        curl \\
        git \\
        build-essential \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
`;
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged).toContain('FROM ubuntu:24.04');
    expect(merged).toContain('WORKDIR /workspace');
    expect(merged).not.toContain('having them in your base');
    expect(merged.match(/apt-get update/g)?.length).toBe(1);
  });

  test('result ends with a trailing newline', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...COMMON });
    expect(merged.endsWith('\n')).toBe(true);
  });

  test('agentBrowserVersion is optional — falls back to the pinned default', () => {
    const { agentBrowserVersion, ...withoutVersion } = COMMON;
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...withoutVersion });
    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
  });

  test('platform default Dockerfile composes to a valid image', () => {
    const merged = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      ...COMMON,
    });
    expect(merged.startsWith('# syntax=docker/dockerfile:1.7')).toBe(true);
    expect(merged).toContain('FROM ubuntu:24.04');
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
  });
});

describe('extractSandboxDefault', () => {
  test('returns null when unset / no sandbox table', () => {
    expect(extractSandboxDefault(null)).toBeNull();
    expect(extractSandboxDefault({})).toBeNull();
    expect(extractSandboxDefault({ sandbox: {} })).toBeNull();
  });

  test('returns the configured default slug', () => {
    expect(extractSandboxDefault({ sandbox: { default: 'dev' } })).toBe('dev');
    expect(extractSandboxDefault({ sandbox: { default: '  dev  ' } })).toBe('dev');
  });

  test('treats the reserved "default" as no override (null)', () => {
    expect(extractSandboxDefault({ sandbox: { default: DEFAULT_SANDBOX_SLUG } })).toBeNull();
  });

  test('ignores non-string / invalid-slug values', () => {
    expect(extractSandboxDefault({ sandbox: { default: 42 } })).toBeNull();
    expect(extractSandboxDefault({ sandbox: { default: 'Not A Slug!' } })).toBeNull();
    expect(extractSandboxDefault({ sandbox: ['array', 'not', 'table'] })).toBeNull();
  });
});

describe('extractSandboxTemplates', () => {
  test('returns an empty list for null / missing / specless manifest', () => {
    expect(extractSandboxTemplates(null)).toEqual([]);
    expect(extractSandboxTemplates({})).toEqual([]);
  });

  test('parses [[sandbox.templates]] array entries in order', () => {
    const out = extractSandboxTemplates({
      sandbox: {
        templates: [
          { slug: 'ml', dockerfile: '.kortix/Dockerfile.ml', cpu: 4, memory: 16 },
          { slug: 'python', image: 'python:3.12-slim' },
        ],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ slug: 'ml', dockerfile: '.kortix/Dockerfile.ml' });
    expect(out[0].spec).toEqual({ cpu: 4, memory: 16 });
    expect(out[1]).toMatchObject({ slug: 'python', image: 'python:3.12-slim' });
  });

  test('legacy singular [sandbox] table (no templates) is ignored', () => {
    const out = extractSandboxTemplates({
      sandbox: { dockerfile: '.kortix/Dockerfile', cpu: 2 },
    });
    expect(out).toHaveLength(0);
  });

  test('legacy [[sandboxes]] form still parses as a migration safety net', () => {
    const out = extractSandboxTemplates({
      sandboxes: [{ slug: 'ml', image: 'python:3.12-slim' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ slug: 'ml', image: 'python:3.12-slim' });
  });

  test('rejects [[sandbox.templates]] entries claiming the reserved "default" slug', () => {
    const out = extractSandboxTemplates({
      sandbox: {
        templates: [
          { slug: 'default', image: 'ubuntu:22.04' },
          { slug: 'ml', image: 'python:3.12-slim' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('ml');
  });

  test('rejects entries with neither dockerfile nor image OK (builder handles missing)', () => {
    const out = extractSandboxTemplates({ sandbox: { templates: [{ slug: 'empty', cpu: 1 }] } });
    expect(out).toHaveLength(1);
    expect(out[0].dockerfile).toBeUndefined();
    expect(out[0].image).toBeUndefined();
  });

  test('skips entries with missing or malformed slugs', () => {
    const out = extractSandboxTemplates({
      sandbox: {
        templates: [
          { dockerfile: 'a' }, // no slug
          { slug: 'Bad Slug!', dockerfile: 'b' }, // invalid chars
          { slug: 'good', dockerfile: 'c' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('good');
  });

  test('deduplicates by slug (first wins)', () => {
    const out = extractSandboxTemplates({
      sandboxes: [
        { slug: 'ml', dockerfile: 'a' },
        { slug: 'ml', image: 'python:3.12-slim' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].dockerfile).toBe('a');
  });

  test('clamps over-spec resources rather than rejecting them', () => {
    const out = extractSandboxTemplates({
      sandboxes: [{ slug: 'huge', dockerfile: 'a', cpu: 9999, memory: 99999 }],
    });
    expect(out[0].spec).toEqual({
      cpu: SANDBOX_SPEC_LIMITS.cpu.max,
      memory: SANDBOX_SPEC_LIMITS.memory.max,
    });
  });

  test('rejects absolute and traversal Dockerfile paths', () => {
    const out = extractSandboxTemplates({
      sandboxes: [
        { slug: 'a', dockerfile: '/etc/Dockerfile' },
        { slug: 'b', dockerfile: '../escape/Dockerfile' },
      ],
    });
    expect(out[0].dockerfile).toBe(undefined);
    expect(out[1].dockerfile).toBe(undefined);
  });
});

describe('buildDefaultSandboxTemplate', () => {
  test('isDefault=true, slug="default"', () => {
    const tpl = buildDefaultSandboxTemplate();
    expect(tpl.isDefault).toBe(true);
    expect(tpl.slug).toBe(DEFAULT_SANDBOX_SLUG);
  });
});
