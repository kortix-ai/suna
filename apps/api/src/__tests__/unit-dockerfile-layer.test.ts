import { describe, expect, test } from 'bun:test';
import {
  buildLayeredDockerfile,
  DEFAULT_SANDBOX_PATHS,
  extractSandboxPaths,
} from '../snapshots/dockerfile-layer';

const COMMON = {
  opencodeVersion: '1.14.28',
  agentBinaryPath: 'kortix-agent',
  entrypointScriptPath: 'kortix-entrypoint',
  agentCliPath: 'kortix-agent-cli',
};

describe('buildLayeredDockerfile', () => {
  test('preserves the user Dockerfile verbatim and appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain('opencode-ai@1.14.28');
    expect(merged).toContain('COPY kortix-agent /usr/local/bin/kortix-agent');
    expect(merged).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
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
