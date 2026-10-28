import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { type AuthedPrincipal, GatewayResolutionError } from '@kortix/llm-gateway';

// Which credentials make which image models reachable for `auto`: the project
// secret names the principal may use, plus the pooled keys granted to it when
// the project turns pooled keys on. The three DB reads are stubbed (the rest of
// each module stays real, for its other importers); the catalog and the plan
// are real.
let access = { disabledProviders: [] as string[], disabledModels: [] as string[] };
let pooledEnabled = false;
let projectNames: string[] = [];
let pooledNames: string[] = [];

const getProjectGatewayResolution = mock(async (_projectId: string) => ({ access, pooledEnabled, customProviders: [] }));
const realAccess = await import('../../repositories/project-model-access');
mock.module('../../repositories/project-model-access', () => ({ ...realAccess, getProjectGatewayResolution }));

const listProjectSecretNamesForConsumer = mock(async (_input: unknown) => projectNames);
const realSurface = await import('../../projects/surface');
mock.module('../../projects/surface', () => ({ ...realSurface, listProjectSecretNamesForConsumer }));

const listGrantedGatewaySecretNames = mock(
  async (_accountId: string, _projectId: string, _userId: string, _personalUserId?: string | null) => pooledNames,
);
const realAccountResource = await import('../../secrets/account-resource');
mock.module('../../secrets/account-resource', () => ({ ...realAccountResource, listGrantedGatewaySecretNames }));

const { resolveGatewayRoute } = await import('./index');

const session: AuthedPrincipal = { accountId: 'acct-1', userId: 'user-1', projectId: 'proj-1' };

async function planned(principal: AuthedPrincipal): Promise<string[]> {
  const plan = await resolveGatewayRoute(principal, { requestedModel: 'auto', requires: { imageInput: false, imageOutput: true } });
  expect(plan.policyId).toBe('image');
  return [plan.primaryModel!, ...(plan.fallbackModels ?? [])];
}

describe('the image models a principal reaches', () => {
  beforeEach(() => {
    access = { disabledProviders: [], disabledModels: [] };
    pooledEnabled = false;
    projectNames = [];
    pooledNames = [];
    getProjectGatewayResolution.mockClear();
    listProjectSecretNamesForConsumer.mockClear();
    listGrantedGatewaySecretNames.mockClear();
  });

  test('a session reaches its project secrets; with pooled keys off no grant is read', async () => {
    projectNames = ['CODEX_AUTH_JSON', 'GOOGLE_GENERATIVE_AI_API_KEY'];
    expect(await planned(session)).toEqual(['codex/gpt-image-2', 'google/gemini-2.5-flash-image']);
    expect(listProjectSecretNamesForConsumer).toHaveBeenCalledWith({
      projectId: 'proj-1', principalUserId: 'user-1', consumer: 'llm_gateway',
    });
    expect(listGrantedGatewaySecretNames).not.toHaveBeenCalled();
  });

  test('with pooled keys on, a session also reaches the keys granted to it', async () => {
    pooledEnabled = true;
    projectNames = ['OPENAI_API_KEY'];
    pooledNames = ['CODEX_AUTH_JSON', 'XAI_API_KEY'];
    expect(await planned(session)).toEqual(['codex/gpt-image-2', 'openai/gpt-image-1.5', 'xai/grok-imagine-image']);
    expect(listGrantedGatewaySecretNames).toHaveBeenCalledWith('acct-1', 'proj-1', 'user-1', 'user-1');
  });

  test('a gateway API key reaches only pooled keys shared with the whole project', async () => {
    pooledEnabled = true;
    pooledNames = ['XAI_API_KEY'];
    expect(await planned({ ...session, keyId: 'key-1' })).toEqual(['xai/grok-imagine-image']);
    expect(listGrantedGatewaySecretNames).toHaveBeenCalledWith('acct-1', 'proj-1', 'user-1', null);
  });

  test('a principal with no personal owner reads no personal secret or grant', async () => {
    pooledEnabled = true;
    projectNames = ['CODEX_AUTH_JSON'];
    expect(await planned({ ...session, personalUserId: null })).toEqual(['codex/gpt-image-2']);
    expect(listProjectSecretNamesForConsumer).toHaveBeenCalledWith({
      projectId: 'proj-1', principalUserId: null, consumer: 'llm_gateway',
    });
    expect(listGrantedGatewaySecretNames).toHaveBeenCalledWith('acct-1', 'proj-1', 'user-1', null);
  });

  test('the project model access removes a disabled provider from the plan', async () => {
    access = { disabledProviders: ['codex'], disabledModels: [] };
    projectNames = ['CODEX_AUTH_JSON', 'XAI_API_KEY'];
    expect(await planned(session)).toEqual(['xai/grok-imagine-image']);
  });

  test('a principal with no project reads no credential and reaches no image model', async () => {
    const { projectId: _, ...accountOnly } = session;
    const error = await planned(accountOnly).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayResolutionError);
    expect((error as GatewayResolutionError).code).toBe('image_model_unavailable');
    expect(getProjectGatewayResolution).not.toHaveBeenCalled();
    expect(listProjectSecretNamesForConsumer).not.toHaveBeenCalled();
  });
});
