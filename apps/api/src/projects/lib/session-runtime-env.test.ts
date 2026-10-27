import { describe, expect, test } from 'bun:test';
import {
  COMPILED_AGENT_CONFIG_ENV,
  COMPILED_AGENT_CONFIG_GZ_PARTS_ENV,
  MAX_ENV_STRING_BYTES,
  envStringBytes,
  readCompiledAgentConfigEnv,
} from '@kortix/api-contract/compiled-agent-config-env';
import { agentConfigEtag } from './compile-agent-config';
import {
  auditRelayEnvPassthrough,
  buildSessionRuntimeEnv,
} from './session-runtime-env';

/**
 * Compiled agent config JSON whose `KORTIX_COMPILED_AGENT_CONFIG=<json>\0` is
 * exactly `envBytes` long: agents with prompt-length prose, the last one
 * trimmed to land on the size.
 */
function oversizedCompiledConfig(envBytes: number): string {
  const words = 'agent reads the repository plans then edits files and reports what changed with a short summary'.split(' ');
  const prose = (seed: number, chars: number) => {
    let out = '';
    for (let i = seed; out.length < chars; i = (i * 1103515245 + 12345) % 2147483648) out += `${words[i % words.length]} `;
    return out.slice(0, chars);
  };
  const config = { default_agent: 'build', agent: {} as Record<string, { mode: string; prompt: string; permission: unknown }> };
  const size = () => envStringBytes(COMPILED_AGENT_CONFIG_ENV, JSON.stringify(config));
  let index = 0;
  while (size() < envBytes - 20_000) {
    config.agent[`agent-${index}`] = { mode: 'subagent', prompt: prose(index + 1, 15_000), permission: { bash: 'ask' } };
    index++;
  }
  config.agent.build = { mode: 'primary', prompt: '', permission: { edit: 'allow' } };
  config.agent.build.prompt = prose(7, envBytes - size());
  return JSON.stringify(config);
}

const BASE_INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
};

describe('buildSessionRuntimeEnv — server-claimed initial turn', () => {
  test('never injects the prompt or turn-ledger identity', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);

    expect(env).not.toHaveProperty('KORTIX_INITIAL_PROMPT');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_TOKEN');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_MESSAGE_ID');
  });

});

describe('buildSessionRuntimeEnv — KORTIX_HARNESS', () => {
  test('every new box runs pi: KORTIX_HARNESS=pi, next to the same model and compiled config keys', () => {
    // An unset KORTIX_HARNESS boots OpenCode in kortixd, so the key is never left out.
    expect(buildSessionRuntimeEnv(BASE_INPUT).KORTIX_HARNESS).toBe('pi');
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      opencodeModel: 'kortix/claude-sonnet-5',
      compiledAgentConfig: JSON.stringify({ agent: { build: { prompt: 'x' } } }),
    });
    expect(env.KORTIX_HARNESS).toBe('pi');
    // D3: the harness-neutral name, plus the pre-W3 name for an older daemon.
    expect(env.KORTIX_MODEL).toBe('kortix/claude-sonnet-5');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('kortix/claude-sonnet-5');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toContain('"build"');
    expect(env.KORTIX_BOOTSTRAP_RUNTIME_SESSION).toBe('1');
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_PI_PACKAGES', () => {
  const packages = ['npm:pi-web-access@0.30.0', { source: './.kortix/pi/audit.ts' }];

  test('a pi session carries the project packages as JSON', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages });
    expect(JSON.parse(env.KORTIX_PI_PACKAGES!)).toEqual(packages);
  });

  test('a built bundle travels as its URL and digest, to a pi session only', () => {
    const bundle = { digest: 'a'.repeat(64), url: 'https://bucket.example/pi-packages/x.tar.gz?sig=1', fallbackUrl: 'https://bucket.example/pi-packages/x.node_modules.tar.gz?sig=2' };
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages, piPackagesBundle: bundle });
    expect(env.KORTIX_PI_PACKAGES_BUNDLE_URL).toBe(bundle.url);
    expect(env.KORTIX_PI_PACKAGES_BUNDLE_DIGEST).toBe(bundle.digest);
    expect(env.KORTIX_PI_PACKAGES_FALLBACK_URL).toBe(bundle.fallbackUrl);
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages, piPackagesBundle: null })).not.toHaveProperty('KORTIX_PI_PACKAGES_BUNDLE_URL');
  });

  test('no key for a session without packages', () => {
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: [] })).not.toHaveProperty('KORTIX_PI_PACKAGES');
    expect(buildSessionRuntimeEnv(BASE_INPUT)).not.toHaveProperty('KORTIX_PI_PACKAGES');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_PI_CODEMODE', () => {
  test('a pi session carries the manifest value; none leaves the daemon default', () => {
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: 'only' }).KORTIX_PI_CODEMODE).toBe('only');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: 'off' }).KORTIX_PI_CODEMODE).toBe('off');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: null })).not.toHaveProperty('KORTIX_PI_CODEMODE');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_COMPILED_AGENT_CONFIG', () => {
  test('omits the key entirely for a v1 project (compiledAgentConfig absent) — byte-for-byte unaffected', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('omits the key when compiledAgentConfig is explicitly null', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: null });
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('carries the compiled JSON through verbatim for a v2 project', () => {
    const compiled = JSON.stringify({ agent: { support: { mode: 'primary' } } });
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  test('coexists with KORTIX_OPENCODE_MODEL — the per-session override key is unaffected', () => {
    const compiled = JSON.stringify({ agent: {} });
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledAgentConfig: compiled,
      opencodeModel: 'anthropic/claude-opus-4-8',
    });
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  // Platinum prod, 2026-10-14: every create whose `KORTIX_COMPILED_AGENT_CONFIG=…\0`
  // was over 131,072 bytes failed to exec in the guest (kortix-ai/platinum#1569).
  test.each([131_734, 269_979])(
    'a %d-byte config leaves the create with no env string over the exec limit, and the etag names the JSON',
    (envBytes) => {
      const compiled = oversizedCompiledConfig(envBytes);
      expect(envStringBytes(COMPILED_AGENT_CONFIG_ENV, compiled)).toBe(envBytes);

      const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });

      for (const [name, value] of Object.entries(env)) {
        expect(envStringBytes(name, value), name).toBeLessThanOrEqual(MAX_ENV_STRING_BYTES);
      }
      expect(env).not.toHaveProperty(COMPILED_AGENT_CONFIG_ENV);
      expect(env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]).toBe('1');
      expect(readCompiledAgentConfigEnv(env)).toBe(compiled);
      // The etag stays the hash of the JSON, so the box reports the same
      // identity whichever form the config travelled in.
      expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(agentConfigEtag(compiled)!);
    },
  );

  test('a config at the exec limit still travels raw, for a daemon that predates the gzip form', () => {
    const compiled = oversizedCompiledConfig(MAX_ENV_STRING_BYTES);
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
    expect(Object.keys(env).filter((name) => name.startsWith('KORTIX_COMPILED_AGENT_CONFIG_GZ'))).toEqual([]);
  });

  test('ignores legacy attribution input and emits no attribution variables', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      originRef: 'legacy-reference',
    } as Parameters<typeof buildSessionRuntimeEnv>[0]);

    expect(env).not.toHaveProperty('KORTIX_END_USER_REF');
    expect(env).not.toHaveProperty('KORTIX_ORIGIN_REF');
  });
});

describe('buildSessionRuntimeEnv — workspace mode', () => {
  test('runtime mode removes every project Git coordinate', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      repositoryAccess: false,
    });

    expect(env.KORTIX_REPOSITORY_ACCESS).toBe('0');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env).not.toHaveProperty('KORTIX_REPO_URL');
    expect(env).not.toHaveProperty('KORTIX_DEFAULT_BRANCH');
    expect(env).not.toHaveProperty('KORTIX_BASE_REF');
    expect(env).not.toHaveProperty('KORTIX_BRANCH_NAME');
  });

  test('read mode cannot clone before exact-path artifacts are implemented', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      repositoryAccess: false,
    });

    expect(env.KORTIX_REPOSITORY_ACCESS).toBe('0');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env).not.toHaveProperty('KORTIX_REPO_URL');
    expect(env).not.toHaveProperty('KORTIX_DEFAULT_BRANCH');
    expect(env).not.toHaveProperty('KORTIX_BASE_REF');
    expect(env).not.toHaveProperty('KORTIX_BRANCH_NAME');
  });

  test('legacy and branch sessions keep the project clone and Git coordinates', () => {
    for (const env of [
      buildSessionRuntimeEnv(BASE_INPUT),
      buildSessionRuntimeEnv({ ...BASE_INPUT, repositoryAccess: true }),
    ]) {
      expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('1');
      expect(env.KORTIX_REPO_URL).toBe(BASE_INPUT.repoUrl);
      expect(env.KORTIX_DEFAULT_BRANCH).toBe(BASE_INPUT.baseRef);
      expect(env.KORTIX_BASE_REF).toBe(BASE_INPUT.baseRef);
      expect(env.KORTIX_BRANCH_NAME).toBe(BASE_INPUT.sessionId);
    }
  });
});

describe('buildSessionRuntimeEnv — fast Git boot hints', () => {
  test('marks replacement runtimes for remote session-branch restoration', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      restoreSessionBranch: true,
    });

    expect(env.KORTIX_SESSION_BRANCH_RESTORE).toBe('1');
    expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
  });

  test('does not emit branch-restore authority for repository-free workspaces', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      repositoryAccess: false,
      restoreSessionBranch: true,
    });

    expect(env).not.toHaveProperty('KORTIX_SESSION_BRANCH_RESTORE');
  });

  test('sends fresh-session and base-tip hints for a fresh session', () => {
    // 2026-08-27: the fresh-session fast path is the default boot (decided at
    // create).
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      freshSession: true,
      baseSha: 'a'.repeat(40),
      gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
      gitDeltaParentSha: 'b'.repeat(40),
      gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
    });

    expect(env.KORTIX_SESSION_FRESH).toBe('1');
    expect(env.KORTIX_BASE_SHA).toBe('a'.repeat(40));
    expect(env.KORTIX_GIT_DELTA_BUNDLE_BASE64).toBe('R0lUIEJVTkRMRQ==');
    expect(env.KORTIX_GIT_DELTA_PARENT_SHA).toBe('b'.repeat(40));
    expect(env.KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64).toBe('dHJlZSBkZWFkYmVlZgo=');
  });

  test('marks a remote delta for fresh sessions only; no config-dir hint (nothing reads it)', () => {
    const fresh = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      freshSession: true,
      baseSha: 'a'.repeat(40),
      gitDeltaBundleRemote: true,
      gitDeltaParentSha: 'b'.repeat(40),
      gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
    });
    expect(fresh.KORTIX_GIT_DELTA_BUNDLE_REMOTE).toBe('1');
    expect(fresh).not.toHaveProperty('KORTIX_GIT_DELTA_BUNDLE_BASE64');
    expect(fresh).not.toHaveProperty('KORTIX_OPENCODE_CONFIG_DIR_HINT');

    for (const env of [
      buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: true, baseSha: 'a'.repeat(40) }),
      buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: false, gitDeltaBundleRemote: true }),
      buildSessionRuntimeEnv({ ...BASE_INPUT, repositoryAccess: false, freshSession: true }),
    ]) {
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_BUNDLE_REMOTE');
    }
  });

  test('omits both hints for resumed and non-repository sessions', () => {
    for (const env of [
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        freshSession: false,
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
        gitDeltaParentSha: 'b'.repeat(40),
        gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
      }),
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        repositoryAccess: false,
        freshSession: true,
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
        gitDeltaParentSha: 'b'.repeat(40),
        gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
      }),
    ]) {
      expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
      expect(env).not.toHaveProperty('KORTIX_BASE_SHA');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_BUNDLE_BASE64');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_SHA');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64');
    }
  });
});

describe('audit relay emission knobs', () => {
  test('forwards nothing when the operator set nothing', () => {
    expect(auditRelayEnvPassthrough({})).toEqual({});
    expect(buildSessionRuntimeEnv(BASE_INPUT)).not.toHaveProperty('KORTIX_AUDIT_RELAY_BATCH_SIZE');
  });

  test('forwards each knob the operator set, including an empty drop list', () => {
    expect(
      auditRelayEnvPassthrough({
        KORTIX_AUDIT_RELAY_BATCH_SIZE: '100',
        KORTIX_AUDIT_RELAY_FLUSH_MS: '5000',
        // An empty list means "drop nothing" — a real setting, not an absence.
        KORTIX_AUDIT_RELAY_DROP_TYPES: '',
        KORTIX_AUDIT_RELAY_COALESCE: '0',
        KORTIX_UNRELATED: 'x',
      }),
    ).toEqual({
      KORTIX_AUDIT_RELAY_BATCH_SIZE: '100',
      KORTIX_AUDIT_RELAY_FLUSH_MS: '5000',
      KORTIX_AUDIT_RELAY_DROP_TYPES: '',
      KORTIX_AUDIT_RELAY_COALESCE: '0',
    });
  });
});

describe('buildSessionRuntimeEnv — S3 project snapshot pin', () => {
  const PIN = `${'a'.repeat(40)}:${'b'.repeat(64)}:3177064`;

  test('git mode (the default) emits neither the mode nor the pin', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: true, projectSnapshotMode: 'git', projectSnapshotPin: PIN });
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_MODE');
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_PIN');
  });

  test('a fresh full-repository session carries the mode and the identity-only pin', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: true, projectSnapshotMode: 'prefer-s3', projectSnapshotPin: PIN });
    expect(env.KORTIX_PROJECT_SNAPSHOT_MODE).toBe('prefer-s3');
    expect(env.KORTIX_PROJECT_SNAPSHOT_PIN).toBe(PIN);
    // The pin is identity only: never a URL, never a credential.
    expect(env.KORTIX_PROJECT_SNAPSHOT_PIN).not.toMatch(/https?:|X-Amz-/);
  });

  test('a presigned descriptor rides along with the pin, and never without it', () => {
    const descriptor = Buffer.from(JSON.stringify({ format: 'project-snapshot-v2', tree: { url: 'https://s3/x?X-Amz-Signature=1' } })).toString('base64');
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      freshSession: true,
      projectSnapshotMode: 'prefer-s3',
      projectSnapshotPin: PIN,
      projectSnapshotDescriptor: descriptor,
    });
    expect(env.KORTIX_PROJECT_SNAPSHOT_PIN).toBe(PIN);
    expect(env.KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR).toBe(descriptor);
    // A descriptor without a pin is meaningless (the daemon checks the pin first).
    const noPin = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      freshSession: true,
      projectSnapshotMode: 'prefer-s3',
      projectSnapshotPin: null,
      projectSnapshotDescriptor: descriptor,
    });
    expect(noPin).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR');
    // And a resumed session receives neither.
    const resumed = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      freshSession: false,
      restoreSessionBranch: true,
      projectSnapshotMode: 'prefer-s3',
      projectSnapshotPin: PIN,
      projectSnapshotDescriptor: descriptor,
    });
    expect(resumed).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR');
  });

  test('a cache miss carries the mode without a pin (the daemon records the miss and boots from Git)', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: true, projectSnapshotMode: 'prefer-s3', projectSnapshotPin: null });
    expect(env.KORTIX_PROJECT_SNAPSHOT_MODE).toBe('prefer-s3');
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_PIN');
  });

  test('a resumed (not fresh) session never receives the S3 keys', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: false, restoreSessionBranch: true, projectSnapshotMode: 'require-s3', projectSnapshotPin: PIN });
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_MODE');
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_PIN');
    expect(env.KORTIX_SESSION_BRANCH_RESTORE).toBe('1');
  });

  test('a restricted workspace mode receives no repository and therefore no archive', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, freshSession: true, repositoryAccess: false, projectSnapshotMode: 'prefer-s3', projectSnapshotPin: PIN });
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_MODE');
    expect(env).not.toHaveProperty('KORTIX_PROJECT_SNAPSHOT_PIN');
  });
});
