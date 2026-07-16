import { describe, expect, test } from 'bun:test';

import type { SandboxTemplate } from '@kortix/shared/sandbox';

import {
  composeLocalDockerfile,
  dockerBuildArgs,
  resolveLocalTemplate,
} from '../commands/sandboxes-local.ts';

const tpl = (slug: string, extra: Partial<SandboxTemplate> = {}): SandboxTemplate => ({
  slug,
  spec: {},
  dockerfile: `${slug}.Dockerfile`,
  ...extra,
});

describe('composeLocalDockerfile', () => {
  const USER = 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y gdal-bin\n';

  test('includes the pip floor — the thing the local build exists to exercise', () => {
    // Incident (b): the floor's `numpy>=1.26` vs a user's dpkg-owned numpy
    // 1.26.4 → "Cannot uninstall numpy 1.26.4, RECORD file not found". If the
    // composed text doesn't run pip, this command reproduces nothing.
    const out = composeLocalDockerfile(USER, { layer: true });
    expect(out).toContain('/opt/kortix/pyfloor/bin/pip install');
    expect(out).toContain('"numpy>=1.26"');
    expect(out).toContain('apt-get install');
  });

  test('keeps the user Dockerfile verbatim, above the layer', () => {
    const out = composeLocalDockerfile(USER, { layer: true });
    expect(out.startsWith('FROM ubuntu:24.04\nRUN apt-get update')).toBe(true);
    expect(out.indexOf('gdal-bin')).toBeLessThan(out.indexOf('Kortix runtime layer'));
  });

  test('omits the artifact tail — those COPYs need binaries a consumer cannot stage', () => {
    const out = composeLocalDockerfile(USER, { layer: true });
    for (const artifact of [
      'COPY kortix-agent.gz',
      'kortix.gz',
      'kortix-entrypoint',
      'kortix-slack-cli',
      'kortix-executor-sdk',
      'scaffold.git',
      'install-shims.sh',
      'ENTRYPOINT',
    ]) {
      expect(out).not.toContain(artifact);
    }
  });

  test('omits the staged-context steps (opencode config warm-up, warm repo)', () => {
    // Both would emit COPY/clone steps against a context this build doesn't have.
    const out = composeLocalDockerfile(USER, { layer: true });
    expect(out).not.toContain('/opt/kortix/warm-config');
    expect(out).not.toContain('warm-repo');
  });

  test('--no-layer yields the user text alone', () => {
    expect(composeLocalDockerfile(USER, { layer: false })).toBe(USER);
  });

  test('normalizes the legacy starter block the same way the snapshot builder does', () => {
    const legacy =
      'FROM ubuntu:24.04\n\n' +
      '# Bring in baseline tooling. The Kortix layer on top also installs\n' +
      '# git/curl/ca-certificates/nodejs/npm, but having them in your base\n' +
      '# makes interactive sessions snappier.\n' +
      'RUN apt-get update \\\n' +
      '    && apt-get install -y --no-install-recommends \\\n' +
      '        ca-certificates \\\n' +
      '        curl \\\n' +
      '        git \\\n' +
      '        build-essential \\\n' +
      '    && rm -rf /var/lib/apt/lists/*\n';
    expect(composeLocalDockerfile(legacy, { layer: false })).toBe('FROM ubuntu:24.04\n');
  });
});

describe('resolveLocalTemplate', () => {
  test('an explicit slug wins', () => {
    const r = resolveLocalTemplate('web', [tpl('web'), tpl('worker')], 'worker');
    expect(r).toEqual({ template: tpl('web') });
  });

  test('falls back to sandbox.default', () => {
    const r = resolveLocalTemplate(undefined, [tpl('web'), tpl('worker')], 'worker');
    expect('template' in r && r.template.slug).toBe('worker');
  });

  test('falls back to the sole declared template', () => {
    const r = resolveLocalTemplate(undefined, [tpl('only')], null);
    expect('template' in r && r.template.slug).toBe('only');
  });

  test('never silently picks the platform default — it errors, listing the slugs', () => {
    // Building `FROM ubuntu:24.04` + the layer would go green while testing
    // nothing the user wrote. Ambiguity has to be the user's to resolve.
    const r = resolveLocalTemplate(undefined, [tpl('web'), tpl('worker')], null);
    expect('error' in r).toBe(true);
    expect('error' in r && r.error).toContain('web, worker');
  });

  test('with no templates at all it says so, and points at the explicit opt-in', () => {
    const r = resolveLocalTemplate(undefined, [], null);
    expect('error' in r && r.error).toContain('no `sandbox.templates`');
    expect('error' in r && r.error).toContain('--slug default');
  });

  test('`--slug default` is honored explicitly', () => {
    const r = resolveLocalTemplate('default', [tpl('web')], null);
    expect('template' in r && r.template.isDefault).toBe(true);
  });

  test('an unknown slug errors, listing what exists', () => {
    const r = resolveLocalTemplate('nope', [tpl('web')], null);
    expect('error' in r && r.error).toContain('No sandbox template "nope"');
    expect('error' in r && r.error).toContain('web');
  });

  test('a sandbox.default pointing at nothing is called out', () => {
    const r = resolveLocalTemplate(undefined, [tpl('web')], 'ghost');
    expect('error' in r && r.error).toContain('ghost');
  });
});

describe('dockerBuildArgs', () => {
  test('feeds the Dockerfile via stdin with an EMPTY context', () => {
    // A bare `-` context (Dockerfile on stdin) is what makes "the repo is not in
    // the build context" structural rather than a promise. `-f - -` looks like
    // it should work and does not: docker rejects it with "can't use stdin for
    // both build context and dockerfile".
    expect(dockerBuildArgs({ platform: 'linux/arm64', tag: 't:latest', noCache: false })).toEqual([
      'build',
      '--platform',
      'linux/arm64',
      '-t',
      't:latest',
      '-',
    ]);
  });

  test('--no-cache is passed through', () => {
    expect(dockerBuildArgs({ platform: 'linux/amd64', tag: 't', noCache: true })).toContain(
      '--no-cache',
    );
  });
});
