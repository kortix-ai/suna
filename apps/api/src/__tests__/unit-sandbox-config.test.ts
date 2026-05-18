import { describe, expect, test } from 'bun:test';
import {
  buildLayeredDockerfile,
  DEFAULT_SANDBOX,
  extractSandbox,
} from '../projects/sandbox-config';
import {
  KNOWN_SCHEMA_VERSION,
  parseManifestString,
} from '../projects/triggers';

const PROJECT = `
[project]
name = "test"
`;

function manifestWith(block: string) {
  return [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, PROJECT, block].join('\n');
}

describe('[sandbox] — happy paths', () => {
  test('absent section yields the defaults, no errors', () => {
    const parsed = parseManifestString(`kortix_version = 1\n${PROJECT}`);
    expect(extractSandbox(parsed)).toEqual({ spec: { ...DEFAULT_SANDBOX }, errors: [] });
  });

  test('parses an explicit dockerfile + context', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = "infra/base.Dockerfile"
context = "infra"
`));
    expect(extractSandbox(parsed)).toEqual({
      spec: { dockerfile: 'infra/base.Dockerfile', context: 'infra' },
      errors: [],
    });
  });

  test('missing fields fall back to defaults', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = "custom.Dockerfile"
`));
    expect(extractSandbox(parsed)).toEqual({
      spec: { dockerfile: 'custom.Dockerfile', context: '.' },
      errors: [],
    });
  });

  test('empty string fields fall back to defaults', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = ""
context = ""
`));
    expect(extractSandbox(parsed).spec).toEqual({ ...DEFAULT_SANDBOX });
  });

  test('context_dir is accepted as an alias for context', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
context_dir = "build"
`));
    expect(extractSandbox(parsed).spec.context).toBe('build');
  });
});

describe('[sandbox] — validation errors', () => {
  test('absolute dockerfile path is rejected', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = "/etc/Dockerfile"
`));
    const { errors } = extractSandbox(parsed);
    expect(errors[0]!.field).toBe('dockerfile');
    expect(errors[0]!.error).toMatch(/repo-relative/);
  });

  test('parent-escape (..) in dockerfile is rejected', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = "../escape/Dockerfile"
`));
    expect(extractSandbox(parsed).errors[0]!.field).toBe('dockerfile');
  });

  test('absolute context path is rejected', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
context = "/tmp"
`));
    expect(extractSandbox(parsed).errors[0]!.field).toBe('context');
  });

  test('non-string scalar is rejected with a clear error', () => {
    const parsed = parseManifestString(manifestWith(`
[sandbox]
dockerfile = 42
`));
    const { spec, errors } = extractSandbox(parsed);
    expect(spec.dockerfile).toBe('Dockerfile'); // fell back
    expect(errors[0]!.error).toMatch(/must be a string/);
  });

  test('an array `[[sandbox]]` is rejected with guidance', () => {
    const parsed = parseManifestString(manifestWith(`
[[sandbox]]
dockerfile = "Dockerfile"
`));
    expect(extractSandbox(parsed).errors[0]!.error).toMatch(/must be a table/);
  });
});

describe('buildLayeredDockerfile', () => {
  const COMMON = {
    opencodeVersion: '1.14.28',
    agentBinaryPath: '/tmp/kortix-agent',
    entrypointScriptPath: '/tmp/kortix-entrypoint',
  };

  test('preserves the user Dockerfile verbatim, appends the Kortix layer', () => {
    const user = 'FROM ubuntu:24.04\nRUN apt-get install -y foo\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    expect(merged.startsWith('FROM ubuntu:24.04\nRUN apt-get install -y foo')).toBe(true);
    expect(merged).toContain('Kortix runtime layer (auto-injected)');
    expect(merged).toContain('opencode-ai@1.14.28');
    expect(merged).toContain('COPY /tmp/kortix-agent /usr/local/bin/kortix-agent');
    expect(merged).toContain('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
  });

  test('strips trailing whitespace on the user file so the seam is clean', () => {
    const user = 'FROM scratch\n\n\n\n';
    const merged = buildLayeredDockerfile({ userDockerfile: user, ...COMMON });
    // No more than one blank line between user content and the Kortix banner.
    expect(merged).not.toMatch(/\n\n\n# ─── Kortix runtime layer/);
  });

  test('result ends with a trailing newline', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM scratch', ...COMMON });
    expect(merged.endsWith('\n')).toBe(true);
  });
});
