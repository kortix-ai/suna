import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProjectSummary } from '../api/types.ts';
import {
  gitCredentialRequestUrl,
  parseGitCredentialRequest,
  resolveGitCredentialForProject,
} from '../commands/git-credential.ts';

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: 'proj_1',
    account_id: 'acct_1',
    name: 'Demo',
    repo_url: 'https://github.com/acme/demo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Git credential protocol', () => {
  test('parses Git input and reconstructs an HTTP URL with its repository path', () => {
    const request = parseGitCredentialRequest(
      'protocol=https\nhost=dev-api.kortix.com\npath=v1/git/proj_1.git\nignored\n\n',
    );

    expect(request).toEqual({
      protocol: 'https',
      host: 'dev-api.kortix.com',
      path: 'v1/git/proj_1.git',
    });
    expect(gitCredentialRequestUrl(request)).toBe(
      'https://dev-api.kortix.com/v1/git/proj_1.git',
    );
    expect(gitCredentialRequestUrl({ url: 'https://github.com/acme/demo.git' })).toBe(
      'https://github.com/acme/demo.git',
    );
  });

  test('returns the Kortix login token for the linked proxy URL', async () => {
    let mintCalls = 0;
    const credential = await resolveGitCredentialForProject({
      requestUrl: 'https://dev-api.kortix.com/v1/git/proj_1.git',
      project: project({
        git_origin_url: 'https://dev-api.kortix.com/v1/git/proj_1.git',
      }),
      kortixToken: 'kortix_pat_test',
      mintManagedToken: async () => {
        mintCalls += 1;
        return { push_token: 'unused' };
      },
    });

    expect(credential).toEqual({
      username: 'x-access-token',
      password: 'kortix_pat_test',
    });
    expect(mintCalls).toBe(0);
  });

  test('mints a provider token for a matching direct managed origin', async () => {
    let mintCalls = 0;
    const credential = await resolveGitCredentialForProject({
      requestUrl: 'https://github.com/acme/demo.git/',
      project: project({ metadata: { git: { managed: true } } }),
      kortixToken: 'kortix_pat_test',
      mintManagedToken: async () => {
        mintCalls += 1;
        return { push_token: 'github_installation_token', git_username: 'x-github-app' };
      },
    });

    expect(credential).toEqual({
      username: 'x-github-app',
      password: 'github_installation_token',
    });
    expect(mintCalls).toBe(1);
  });

  test('returns no credential for a different URL', async () => {
    let mintCalls = 0;
    const credential = await resolveGitCredentialForProject({
      requestUrl: 'https://github.com/acme/other.git',
      project: project({ metadata: { git: { managed: true } } }),
      kortixToken: 'kortix_pat_test',
      mintManagedToken: async () => {
        mintCalls += 1;
        return { push_token: 'must_not_be_used' };
      },
    });

    expect(credential).toBeNull();
    expect(mintCalls).toBe(0);
  });

  test('machine command emits no host or update notice', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kortix-git-credential-machine-'));
    const config = join(cwd, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        active: 'dev',
        hosts: {
          dev: {
            url: 'https://dev-api.kortix.com',
            token: 'kortix_pat_test',
            user_id: 'user_1',
            user_email: 'user@example.test',
            account_id: 'acct_1',
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'git-credential', 'get'],
      cwd,
      env: {
        ...process.env,
        KORTIX_CONFIG_FILE: config,
        KORTIX_NO_UPDATE_CHECK: '1',
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdin: new Blob(['protocol=https\nhost=dev-api.kortix.com\npath=v1/git/proj_1.git\n\n']),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});
