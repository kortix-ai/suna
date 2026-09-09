import { describe, expect, test } from 'bun:test';
import type { GitBackedProject } from '../projects/git/types';
import {
  prebuildCompiledBootArtifacts,
  prebuildDefaultBranchArtifacts,
  prebuildManifestRuntime,
} from './compiled-prebuild';

const project: GitBackedProject = {
  projectId: 'project-1',
  repoUrl: 'https://github.test/kortix/project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: 'token',
};

function dependencies(calls: string[]) {
  return {
    resolveTip: async () => 'a'.repeat(40),
    buildCheckout: async (
      _project: GitBackedProject,
      ref: string,
      sourceSha: string,
      runtimeRepoUrl: string,
    ) => {
      calls.push(`checkout:${ref}:${sourceSha}:${runtimeRepoUrl}`);
      return { path: 'checkout', sha256: 'b'.repeat(64), size: 1, sourceSha, cacheHit: true };
    },
    buildRuntime: async (_project: GitBackedProject, ref: string, sourceSha: string) => {
      calls.push(`runtime:${ref}:${sourceSha}`);
      return {
        path: 'server.mjs',
        sha256: 'c'.repeat(64),
        size: 1,
        sourceSha,
        cacheHit: true,
        manifest: {
          format: 'kortix.compiled-runtime.v1' as const,
          engine: 'opencode' as const,
          project_id: 'project-1',
          ref,
          source_sha: sourceSha,
          agent_config: null,
          agent_config_etag: null,
          opencode_config_dir: null,
          opencode_config_archive_sha256: null,
          opencode_config_archive_bytes: null,
        },
      };
    },
  };
}

describe('compiled boot prebuild', () => {
  test('builds the checkout and server.mjs for the same exact commit', async () => {
    const calls: string[] = [];
    const result = await prebuildCompiledBootArtifacts(
      project,
      'feature/base',
      'a'.repeat(40),
      'https://api.test/v1/git/project-1.git',
      dependencies(calls),
    );

    expect(calls.sort()).toEqual([
      `checkout:feature/base:${'a'.repeat(40)}:https://api.test/v1/git/project-1.git`,
      `runtime:feature/base:${'a'.repeat(40)}`,
    ]);
    expect(result.checkout.sourceSha).toBe(result.runtime.sourceSha);
  });

  test('resolves the default branch tip before building push artifacts', async () => {
    const calls: string[] = [];
    const result = await prebuildDefaultBranchArtifacts(
      project,
      'https://api.test/v1/git/project-1.git',
      dependencies(calls),
    );

    expect(result?.runtime.manifest.ref).toBe('main');
    expect(result?.runtime.sourceSha).toBe('a'.repeat(40));
  });

});

describe('manifest runtime prebuild', () => {
  for (const enabled of [false, true]) {
    test(`Pi builds only Pi with legacy compiled boot enabled=${enabled}`, async () => {
      const calls: string[] = [];
      const sha = 'a'.repeat(40);
      await prebuildManifestRuntime(project, 'https://api.test/git', enabled, {
        refresh: async () => { calls.push('refresh'); },
        resolveTip: async () => { calls.push('tip'); return sha; },
        resolveRuntime: async (_project, ref) => { calls.push(`manifest:${ref}`); return 'pi'; },
        pi: async (_project, resolveTip) => { calls.push(`pi:${await resolveTip(project, 'main')}`); },
        opencode: async () => { calls.push('opencode'); },
      });
      expect(calls).toEqual(['refresh', 'tip', `manifest:${sha}`, `pi:${sha}`]);
    });
  }

  test('OpenCode preserves the compiled boot switch', async () => {
    for (const enabled of [false, true]) {
      const calls: string[] = [];
      await prebuildManifestRuntime(project, 'https://api.test/git', enabled, {
        refresh: async () => {},
        resolveTip: async () => 'a'.repeat(40),
        resolveRuntime: async () => 'opencode',
        pi: async () => { calls.push('pi'); },
        opencode: async (_project, ref, sha, url) => { calls.push(`${ref}:${sha}:${url}`); },
      });
      expect(calls).toEqual(enabled ? [`main:${'a'.repeat(40)}:https://api.test/git`] : []);
    }
  });

  test('invalid manifests fail without compiling either runtime', async () => {
    const calls: string[] = [];
    await expect(prebuildManifestRuntime(project, 'https://api.test/git', true, {
      refresh: async () => {},
      resolveTip: async () => 'a'.repeat(40),
      resolveRuntime: async () => { throw new Error('runtime contradicts version'); },
      pi: async () => { calls.push('pi'); },
      opencode: async () => { calls.push('opencode'); },
    })).rejects.toThrow('runtime contradicts version');
    expect(calls).toEqual([]);
  });
});
