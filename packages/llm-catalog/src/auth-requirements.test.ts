import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  type ProviderAuthRequirement,
  isProviderAuthSatisfied,
  primaryAuthEnvVars,
  providerAuthRequirement,
} from './index';

function bedrockProvider() {
  const provider = CATALOG.providers.find((p) => p.id === 'amazon-bedrock');
  if (!provider) throw new Error('amazon-bedrock missing from catalog fixture');
  return provider;
}

describe('providerAuthRequirement — Bedrock override', () => {
  test('requires only the bearer token + region, not the SigV4 pair models.dev lists', () => {
    const requirement = providerAuthRequirement(bedrockProvider());
    expect(requirement.methods).toHaveLength(1);
    expect(requirement.methods[0]?.envVars).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
  });

  test("the connect form's primary fields are exactly bearer + region", () => {
    expect(primaryAuthEnvVars(bedrockProvider())).toEqual([
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_REGION',
    ]);
  });

  test('connects with just bearer token + region (the essentia case) — SigV4 keys are never required', () => {
    const requirement = providerAuthRequirement(bedrockProvider());
    const projectSecrets = new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
    expect(isProviderAuthSatisfied(requirement, (v) => projectSecrets.has(v))).toBe(true);
  });

  test('a partially-configured Bedrock (bearer only, no region) does not show connected', () => {
    const requirement = providerAuthRequirement(bedrockProvider());
    const projectSecrets = new Set(['AWS_BEARER_TOKEN_BEDROCK']);
    expect(isProviderAuthSatisfied(requirement, (v) => projectSecrets.has(v))).toBe(false);
  });

  test("the SigV4 access-key pair alone does NOT satisfy the requirement (transport can't use it yet)", () => {
    const requirement = providerAuthRequirement(bedrockProvider());
    const projectSecrets = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']);
    expect(isProviderAuthSatisfied(requirement, (v) => projectSecrets.has(v))).toBe(false);
  });
});

describe('providerAuthRequirement — Google alias override', () => {
  function googleProvider() {
    const provider = CATALOG.providers.find((p) => p.id === 'google');
    if (!provider) throw new Error('google missing from catalog fixture');
    return provider;
  }

  test('any one of the three alias env vars connects it — not all three', () => {
    const requirement = providerAuthRequirement(googleProvider());
    expect(requirement.methods).toHaveLength(3);
    for (const alias of ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
      expect(
        isProviderAuthSatisfied(requirement, (v) => v === alias),
        `${alias} alone should satisfy`,
      ).toBe(true);
    }
  });

  test('primary connect-form field is GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(primaryAuthEnvVars(googleProvider())).toEqual(['GOOGLE_GENERATIVE_AI_API_KEY']);
  });

  test('no secrets at all does not satisfy', () => {
    const requirement = providerAuthRequirement(googleProvider());
    expect(isProviderAuthSatisfied(requirement, () => false)).toBe(false);
  });
});

describe('providerAuthRequirement — default (no override)', () => {
  test('a single-env provider (e.g. groq) derives its one method straight from the catalog', () => {
    const provider = CATALOG.providers.find((p) => p.id === 'groq');
    if (!provider) throw new Error('groq missing from catalog fixture');
    const requirement = providerAuthRequirement(provider);
    expect(requirement.methods).toEqual([{ envVars: ['GROQ_API_KEY'] }]);
    expect(isProviderAuthSatisfied(requirement, (v) => v === 'GROQ_API_KEY')).toBe(true);
    expect(isProviderAuthSatisfied(requirement, () => false)).toBe(false);
  });

  test('a genuine multi-field AND provider (azure) still requires every field together — not the same bug class as bedrock', () => {
    const provider = CATALOG.providers.find((p) => p.id === 'azure');
    if (!provider) throw new Error('azure missing from catalog fixture');
    const requirement = providerAuthRequirement(provider);
    expect(requirement.methods).toHaveLength(1);
    expect(requirement.methods[0]?.envVars.length).toBeGreaterThan(1);
    // Only ONE of azure's two fields present must NOT satisfy — these are
    // different-purpose fields (resource name + key), not aliases.
    const onlyOne = new Set([requirement.methods[0]!.envVars[0]!]);
    expect(isProviderAuthSatisfied(requirement, (v) => onlyOne.has(v))).toBe(false);
  });

  test('a provider with no env vars produces an unsatisfiable (empty-methods) requirement', () => {
    const requirement = providerAuthRequirement({ id: 'definitely-not-a-real-provider', env: [] });
    expect(requirement.methods).toEqual([]);
    expect(isProviderAuthSatisfied(requirement, () => true)).toBe(false);
  });
});

describe('isProviderAuthSatisfied — any-of-methods semantics (synthetic)', () => {
  test('satisfied when ANY method is fully present, even if other methods are only partially set', () => {
    const requirement: ProviderAuthRequirement = {
      methods: [
        { label: 'bearer', envVars: ['TOKEN_A'] },
        { label: 'keypair', envVars: ['KEY_ID', 'KEY_SECRET'] },
      ],
    };
    // Only the bearer method's var is set — should satisfy via method 1 even
    // though method 2 isn't touched at all.
    expect(isProviderAuthSatisfied(requirement, (v) => v === 'TOKEN_A')).toBe(true);
    // Only half of the keypair method is set — no method is fully satisfied.
    expect(isProviderAuthSatisfied(requirement, (v) => v === 'KEY_ID')).toBe(false);
    // The full keypair method satisfies too, independent of the bearer one.
    expect(isProviderAuthSatisfied(requirement, (v) => v === 'KEY_ID' || v === 'KEY_SECRET')).toBe(
      true,
    );
    // Neither method satisfied.
    expect(isProviderAuthSatisfied(requirement, () => false)).toBe(false);
  });
});
