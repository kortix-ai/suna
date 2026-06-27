import { describe, expect, test } from 'bun:test';
import {
  AGENT_BROWSER_VERSION,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
} from '@kortix/shared';
import {
  buildDefaultSandboxTemplate,
  buildLayeredDockerfile,
  DEFAULT_SANDBOX_SLUG,
  extractSandboxDefault,
  extractSandboxTemplates,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  SANDBOX_SPEC_LIMITS,
} from '../snapshots/dockerfile-layer';

const COMMON = {
  opencodeVersion: OPENCODE_VERSION,
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  slackCliPath: 'kortix-slack-cli',
  executorSdkPath: 'kortix-executor-sdk',
};

describe('buildLayeredDockerfile', () => {
  test('preserves the user Dockerfile verbatim and appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain(`opencode-ai@${OPENCODE_VERSION}`);
    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
    expect(merged).toContain('python3 python3-dev python3-pip python3-venv');
    expect(merged).toContain('"openpyxl>=3.1"');
    expect(merged).toContain('"pandas>=2.2"');
    expect(merged).toContain('"playwright>=1.58"');
    expect(merged).toContain('importlib.import_module(mod)');
    expect(merged).toContain('COPY kortix-agent.gz /tmp/kortix-agent.gz');
    expect(merged).toContain('gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent');
    // The admin CLI is baked alongside the daemon and verified at build time.
    expect(merged).toContain('COPY kortix.gz /tmp/kortix.gz');
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
    expect(merged).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium');
    expect(merged).toContain('/opt/kortix/home/.agent-browser/browsers/chrome-linux64');
    // The build FAILS LOUDLY if Chromium didn't wire up — never install at runtime.
    expect(merged).toContain('/usr/local/bin/chromium --version');
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

  test('does NOT bake the project workspace into the image', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...COMMON });
    expect(merged).not.toContain('kortix-workspace.tar.gz');
    expect(merged).not.toContain('tar -xzf');
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
