import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

let sessionRows: Array<Record<string, unknown>> = [];
let projectRows: Array<Record<string, unknown>> = [];
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === projectSessions ? sessionRows : table === projects ? projectRows : [],
        }),
      }),
    }),
  },
}));

let grant: string[] | 'all' | undefined | Error = 'all';
const grantInputs: Array<Record<string, unknown>> = [];
mock.module('./secret-grant', () => ({
  resolveSessionSecretGrant: async (input: Record<string, unknown>) => {
    grantInputs.push(input);
    if (grant instanceof Error) throw grant;
    return grant;
  },
}));

const { sessionWithheldSecrets, withheldSecrets, withheldSecretsFix } = await import(
  './session-secret-reach'
);

beforeEach(() => {
  sessionRows = [{ projectId: 'project-1', agentName: 'analyst', secretsAllowlist: null }];
  projectRows = [{ repoUrl: 'https://git.example/repo.git', defaultBranch: 'main', manifestPath: 'kortix.yaml' }];
  grant = 'all';
  grantInputs.length = 0;
});

describe('withheldSecrets', () => {
  test('an unrestricted grant and no allowlist withhold nothing', () => {
    expect(withheldSecrets(['API_KEY'], 'all', null)).toEqual([]);
    expect(withheldSecrets(['API_KEY'], undefined, undefined)).toEqual([]);
  });

  test('a name outside an explicit grant is withheld by the agent grant', () => {
    expect(withheldSecrets(['API_KEY', 'OTHER_KEY'], ['OTHER_KEY'], null)).toEqual([
      { name: 'API_KEY', reason: 'agent_grant' },
    ]);
  });

  test('grant membership is case-insensitive, like agentMayUseEnv', () => {
    expect(withheldSecrets(['API_KEY'], ['api_key'], null)).toEqual([]);
  });

  test('an empty grant withholds every name', () => {
    expect(withheldSecrets(['A', 'B'], [], null)).toEqual([
      { name: 'A', reason: 'agent_grant' },
      { name: 'B', reason: 'agent_grant' },
    ]);
  });

  test('a granted name outside the session allowlist is withheld by the allowlist', () => {
    expect(withheldSecrets(['API_KEY'], 'all', ['OTHER_KEY'])).toEqual([
      { name: 'API_KEY', reason: 'session_allowlist' },
    ]);
    expect(withheldSecrets(['API_KEY'], ['API_KEY'], [])).toEqual([
      { name: 'API_KEY', reason: 'session_allowlist' },
    ]);
  });

  test('the agent grant is named first when both exclude a name', () => {
    expect(withheldSecrets(['API_KEY'], ['OTHER_KEY'], ['OTHER_KEY'])).toEqual([
      { name: 'API_KEY', reason: 'agent_grant' },
    ]);
  });
});

describe('sessionWithheldSecrets', () => {
  test('resolves the session agent grant fresh and names what it withholds', async () => {
    grant = ['OTHER_KEY'];
    expect(await sessionWithheldSecrets('session-1', ['API_KEY', 'OTHER_KEY'])).toEqual({
      agent: 'analyst',
      withheld: [{ name: 'API_KEY', reason: 'agent_grant' }],
    });
    expect(grantInputs[0]).toMatchObject({
      projectId: 'project-1',
      sessionAgent: 'analyst',
      defaultBranch: 'main',
      forceRefresh: true,
    });
  });

  test('applies the session allowlist', async () => {
    sessionRows = [{ projectId: 'project-1', agentName: 'analyst', secretsAllowlist: ['OTHER_KEY'] }];
    expect(await sessionWithheldSecrets('session-1', ['API_KEY'])).toEqual({
      agent: 'analyst',
      withheld: [{ name: 'API_KEY', reason: 'session_allowlist' }],
    });
  });

  test('nothing withheld → null', async () => {
    expect(await sessionWithheldSecrets('session-1', ['API_KEY'])).toBeNull();
  });

  test('a missing session → null, no grant lookup', async () => {
    sessionRows = [];
    expect(await sessionWithheldSecrets('session-1', ['API_KEY'])).toBeNull();
    expect(grantInputs).toHaveLength(0);
  });

  test('an unreadable manifest → null: advisory, never a guess', async () => {
    grant = new Error('manifest unreadable');
    expect(await sessionWithheldSecrets('session-1', ['API_KEY'])).toBeNull();
  });
});

describe('withheldSecretsFix', () => {
  test('names the agent, the Customize path, the CLI command and the sync', () => {
    const text = withheldSecretsFix('analyst', [{ name: 'API_KEY', reason: 'agent_grant' }]);
    expect(text).toContain('API_KEY is not in agent "analyst"\'s secrets grant');
    expect(text).toContain('Customize → Agents → analyst → Secrets');
    expect(text).toContain('kortix secrets grant API_KEY --agent analyst');
    expect(text).toContain('cannot widen its own grant');
    expect(text).toContain('pushes the change to this session when it is saved');
    expect(text).toContain('cannot run `kortix secrets sync`');
  });

  test('several names use a placeholder command', () => {
    const text = withheldSecretsFix('analyst', [
      { name: 'A_KEY', reason: 'agent_grant' },
      { name: 'B_KEY', reason: 'agent_grant' },
    ]);
    expect(text).toContain('A_KEY, B_KEY are not in agent');
    expect(text).toContain('kortix secrets grant <NAME> --agent analyst');
  });

  test('an allowlist exclusion points at a new session, not at the grant', () => {
    const text = withheldSecretsFix('analyst', [{ name: 'API_KEY', reason: 'session_allowlist' }]);
    expect(text).toContain("outside this session's secrets allowlist");
    expect(text).not.toContain('Customize');
  });
});
