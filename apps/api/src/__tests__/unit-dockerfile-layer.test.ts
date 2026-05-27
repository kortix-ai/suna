import { describe, expect, test } from 'bun:test';
import {
  buildLayeredDockerfile,
  DEFAULT_SANDBOX_PATHS,
  extractSandboxPaths,
  extractSandboxSpec,
  sandboxSpecIsEmpty,
  SANDBOX_SPEC_LIMITS,
} from '../snapshots/dockerfile-layer';

const COMMON = {
  opencodeVersion: '1.15.10',
  agentBrowserVersion: '0.27.0',
  agentBinaryPath: 'kortix-agent.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  agentCliPath: 'kortix-agent-cli',
  executorSdkPath: 'kortix-executor-sdk',
  workspaceArchivePath: 'kortix-workspace.tar.gz',
};

describe('buildLayeredDockerfile', () => {
  test('preserves the user Dockerfile verbatim and appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain('opencode-ai@1.15.10');
    expect(merged).toContain('agent-browser@0.27.0');
    expect(merged).toContain('AGENT_BROWSER_ARGS=--no-sandbox');
    expect(merged).not.toContain('playwright');
    expect(merged).not.toContain('kortix.com/install');
    expect(merged).toContain('COPY kortix-agent.gz /tmp/kortix-agent.gz');
    expect(merged).toContain('gunzip -c /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent');
    expect(merged).toContain('COPY kortix-agent-cli/ /opt/kortix/apps/sandbox/agent-cli/');
    expect(merged).toContain('COPY kortix-executor-sdk/ /opt/kortix/packages/executor-sdk/');
    expect(merged).toContain('COPY kortix-workspace.tar.gz /tmp/kortix-workspace.tar.gz');
    expect(merged).toContain('tar -xzf /tmp/kortix-workspace.tar.gz -C /workspace');
    expect(merged).toContain('test -d /workspace/.git');
    expect(merged).toContain('mkdir -p /opt/kortix/home /ephemeral/kortix-master/opencode');
    expect(merged).not.toContain('opencode serve --port 4096');
    expect(merged).toContain(
      'bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli',
    );
    expect(merged).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
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

  test('trims trailing whitespace before the seam so blank-line runs do not stack', () => {
    const user = 'FROM scratch\n\n\n\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged).not.toMatch(/\n\n\n# ─── Kortix runtime layer/);
  });

  test('result ends with a trailing newline', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...COMMON });
    expect(merged.endsWith('\n')).toBe(true);
  });

  test('agentBrowserVersion is optional — falls back to the pinned default', () => {
    const { agentBrowserVersion, ...withoutVersion } = COMMON;
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...withoutVersion });
    expect(merged).toContain('agent-browser@0.27.0');
    expect(merged).not.toContain('playwright');
  });
});

describe('extractSandboxPaths', () => {
  test('returns defaults for a null / missing manifest', () => {
    expect(extractSandboxPaths(null)).toEqual(DEFAULT_SANDBOX_PATHS);
    expect(extractSandboxPaths({})).toEqual(DEFAULT_SANDBOX_PATHS);
  });

  test('picks up explicit dockerfile + context', () => {
    const paths = extractSandboxPaths({
      sandbox: { dockerfile: 'infra/base.Dockerfile', context: 'infra' },
    });
    expect(paths).toEqual({ dockerfile: 'infra/base.Dockerfile', context: 'infra' });
  });

  test('falls back when sandbox section is malformed', () => {
    // Array, not table
    expect(extractSandboxPaths({ sandbox: [{ dockerfile: 'x' }] })).toEqual(DEFAULT_SANDBOX_PATHS);
    // Scalar
    expect(extractSandboxPaths({ sandbox: 'oops' })).toEqual(DEFAULT_SANDBOX_PATHS);
  });

  test('rejects absolute and traversal paths by falling back', () => {
    expect(
      extractSandboxPaths({ sandbox: { dockerfile: '/etc/Dockerfile' } }).dockerfile,
    ).toBe(DEFAULT_SANDBOX_PATHS.dockerfile);
    expect(
      extractSandboxPaths({ sandbox: { dockerfile: '../escape/Dockerfile' } }).dockerfile,
    ).toBe(DEFAULT_SANDBOX_PATHS.dockerfile);
    expect(
      extractSandboxPaths({ sandbox: { context: '/tmp' } }).context,
    ).toBe(DEFAULT_SANDBOX_PATHS.context);
  });

  test('accepts context_dir as an alias for context', () => {
    expect(
      extractSandboxPaths({ sandbox: { context_dir: 'build' } }).context,
    ).toBe('build');
  });

  test('empty strings fall back to defaults', () => {
    expect(
      extractSandboxPaths({ sandbox: { dockerfile: '', context: '' } }),
    ).toEqual(DEFAULT_SANDBOX_PATHS);
  });
});

describe('extractSandboxSpec', () => {
  test('returns an empty spec for a null / missing / specless manifest', () => {
    expect(extractSandboxSpec(null)).toEqual({});
    expect(extractSandboxSpec({})).toEqual({});
    expect(extractSandboxSpec({ sandbox: { dockerfile: '.kortix/Dockerfile' } })).toEqual({});
  });

  test('picks up cpu / memory / disk / gpu', () => {
    expect(
      extractSandboxSpec({ sandbox: { cpu: 4, memory: 8, disk: 50, gpu: 1 } }),
    ).toEqual({ cpu: 4, memory: 8, disk: 50, gpu: 1 });
  });

  test('partial specs only carry the fields that are set', () => {
    expect(extractSandboxSpec({ sandbox: { cpu: 2 } })).toEqual({ cpu: 2 });
    expect(extractSandboxSpec({ sandbox: { memory: 16 } })).toEqual({ memory: 16 });
  });

  test('accepts friendly aliases (cpus / memory_gb / mem / disk_gb)', () => {
    expect(extractSandboxSpec({ sandbox: { cpus: 8 } })).toEqual({ cpu: 8 });
    expect(extractSandboxSpec({ sandbox: { memory_gb: 32 } })).toEqual({ memory: 32 });
    expect(extractSandboxSpec({ sandbox: { mem: 4 } })).toEqual({ memory: 4 });
    expect(extractSandboxSpec({ sandbox: { disk_gb: 100 } })).toEqual({ disk: 100 });
    // Canonical key wins over its alias when both are present.
    expect(extractSandboxSpec({ sandbox: { cpu: 2, cpus: 8 } })).toEqual({ cpu: 2 });
  });

  test('coerces numeric strings and rounds fractional values', () => {
    expect(extractSandboxSpec({ sandbox: { cpu: '4', memory: '8' } })).toEqual({ cpu: 4, memory: 8 });
    expect(extractSandboxSpec({ sandbox: { cpu: 2.6 } })).toEqual({ cpu: 3 });
  });

  test('drops non-positive / non-numeric values (→ provider default)', () => {
    expect(extractSandboxSpec({ sandbox: { cpu: 0, memory: -4 } })).toEqual({});
    expect(extractSandboxSpec({ sandbox: { cpu: 'lots', disk: NaN } })).toEqual({});
    expect(extractSandboxSpec({ sandbox: { gpu: 0 } })).toEqual({});
  });

  test('clamps values above the ceiling rather than rejecting them', () => {
    expect(extractSandboxSpec({ sandbox: { cpu: 9999 } })).toEqual({
      cpu: SANDBOX_SPEC_LIMITS.cpu.max,
    });
    expect(extractSandboxSpec({ sandbox: { memory: 10000 } })).toEqual({
      memory: SANDBOX_SPEC_LIMITS.memory.max,
    });
  });

  test('falls back when the sandbox section is malformed', () => {
    expect(extractSandboxSpec({ sandbox: [{ cpu: 4 }] })).toEqual({});
    expect(extractSandboxSpec({ sandbox: 'oops' })).toEqual({});
  });
});

describe('sandboxSpecIsEmpty', () => {
  test('true only when no field is set', () => {
    expect(sandboxSpecIsEmpty({})).toBe(true);
    expect(sandboxSpecIsEmpty({ cpu: 1 })).toBe(false);
    expect(sandboxSpecIsEmpty({ gpu: 1 })).toBe(false);
  });
});
