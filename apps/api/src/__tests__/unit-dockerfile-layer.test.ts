import { describe, expect, test } from 'bun:test';
import {
  buildDefaultSandboxTemplate,
  buildLayeredDockerfile,
  DEFAULT_SANDBOX_SLUG,
  extractSandboxTemplates,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  sandboxSpecIsEmpty,
  SANDBOX_SPEC_LIMITS,
} from '../snapshots/dockerfile-layer';

const COMMON = {
  opencodeVersion: '1.15.10',
  agentBrowserVersion: '0.27.0',
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  agentCliPath: 'kortix-agent-cli',
  executorSdkPath: 'kortix-executor-sdk',
};

describe('buildLayeredDockerfile', () => {
  test('preserves the user Dockerfile verbatim and appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain('opencode-ai@1.15.10');
    expect(merged).toContain('agent-browser@0.27.0');
    expect(merged).toContain('COPY kortix-agent.gz /tmp/kortix-agent.gz');
    expect(merged).toContain('gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent');
    // The admin CLI is baked alongside the daemon and verified at build time.
    expect(merged).toContain('COPY kortix.gz /tmp/kortix.gz');
    expect(merged).toContain('gunzip -c /tmp/kortix.gz > /usr/local/bin/kortix');
    expect(merged).toContain('kortix --version');
    expect(merged).toContain('COPY kortix-agent-cli/ /opt/kortix/apps/sandbox/agent-cli/');
    expect(merged).toContain('COPY kortix-executor-sdk/ /opt/kortix/packages/executor-sdk/');
    expect(merged).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
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
    expect(merged).toContain('agent-browser@0.27.0');
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

describe('sandboxSpecIsEmpty', () => {
  test('true only when no field is set', () => {
    expect(sandboxSpecIsEmpty({})).toBe(true);
    expect(sandboxSpecIsEmpty({ cpu: 1 })).toBe(false);
    expect(sandboxSpecIsEmpty({ memory: 2 })).toBe(false);
    expect(sandboxSpecIsEmpty({ disk: 10 })).toBe(false);
  });
});
