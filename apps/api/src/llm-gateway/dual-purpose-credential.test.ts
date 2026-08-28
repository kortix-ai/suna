import { describe, expect, test } from 'bun:test';
import { isDualPurposeCredentialEnv } from './sandbox-credentials';

// Prod 2026-08-27, then reproduced on dev 2026-08-28 against the deployed fix:
// creating a project secret named GITHUB_TOKEN stored it as
// `strategy: broker, consumer: llm_gateway`, because models.dev maps its
// `github-copilot` provider to that env name. The row was then withheld from
// the sandbox and the agent could not use the token the user had just added.
describe('isDualPurposeCredentialEnv', () => {
  test('GITHUB_TOKEN is not assumed to be a model credential', () => {
    expect(isDualPurposeCredentialEnv('GITHUB_TOKEN')).toBe(true);
  });

  test('a genuine provider key is still assumed to be one', () => {
    expect(isDualPurposeCredentialEnv('OPENAI_API_KEY')).toBe(false);
    expect(isDualPurposeCredentialEnv('ANTHROPIC_API_KEY')).toBe(false);
    expect(isDualPurposeCredentialEnv('CODEX_AUTH_JSON')).toBe(false);
  });

  test('an unrelated name is unaffected', () => {
    expect(isDualPurposeCredentialEnv('STRIPE_API_KEY')).toBe(false);
  });
});
