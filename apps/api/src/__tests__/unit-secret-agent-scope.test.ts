import { describe, expect, test } from 'bun:test';
import { secretNamesDeniedForAgent } from '../projects/secrets';

// The pure security decision the executor applies at sandbox boot: which of a
// project's agent-scoped secrets a session running AS `agentName` may NOT use.
// `loadSecretAgentScopes` only ever puts RESTRICTED secrets in the map (a NULL /
// empty `agent_scope` = all-agents is omitted), so a secret in the map is denied
// iff its allowlist excludes the running agent.
describe('secretNamesDeniedForAgent', () => {
  test('all-agents secrets are never in the map, so never denied', () => {
    // Empty map = every secret is all-agents (project-wide).
    expect(secretNamesDeniedForAgent(new Map(), 'builder').size).toBe(0);
  });

  test('a scoped secret is denied for an agent NOT in its list', () => {
    const scopes = new Map([['STRIPE_KEY', ['payments-bot']]]);
    expect([...secretNamesDeniedForAgent(scopes, 'builder')]).toEqual(['STRIPE_KEY']);
  });

  test('a scoped secret is allowed for an agent IN its list', () => {
    const scopes = new Map([['STRIPE_KEY', ['payments-bot', 'builder']]]);
    expect(secretNamesDeniedForAgent(scopes, 'builder').size).toBe(0);
  });

  test('mixed project: only the secrets excluding this agent are denied', () => {
    const scopes = new Map([
      ['STRIPE_KEY', ['payments-bot']], // denied for builder
      ['GITHUB_TOKEN', ['builder', 'release-bot']], // allowed for builder
      ['DEPLOY_KEY', ['release-bot']], // denied for builder
    ]);
    expect(secretNamesDeniedForAgent(scopes, 'builder')).toEqual(
      new Set(['STRIPE_KEY', 'DEPLOY_KEY']),
    );
  });

  test('an unknown / empty agent name is denied every scoped secret', () => {
    // A session with no identifiable named agent can never satisfy a specific
    // allowlist — every scoped secret is withheld (fail closed).
    const scopes = new Map([
      ['STRIPE_KEY', ['payments-bot']],
      ['DEPLOY_KEY', ['release-bot']],
    ]);
    expect(secretNamesDeniedForAgent(scopes, '')).toEqual(new Set(['STRIPE_KEY', 'DEPLOY_KEY']));
  });

  test('a secret listing its agent among several others is allowed (case-sensitive exact match)', () => {
    const scopes = new Map([['API_KEY', ['a', 'b', 'builder', 'c']]]);
    expect(secretNamesDeniedForAgent(scopes, 'builder').size).toBe(0);
    // Case matters — agent names are exact.
    expect([...secretNamesDeniedForAgent(scopes, 'Builder')]).toEqual(['API_KEY']);
  });
});
