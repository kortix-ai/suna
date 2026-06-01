import { describe, it, expect } from 'bun:test';
import { isForbiddenSandboxEnv } from '../platform/sandbox-env';

describe('isForbiddenSandboxEnv', () => {
  it('forbids every raw upstream provider key', () => {
    for (const key of [
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'TAVILY_API_KEY',
      'SERPER_API_KEY',
      'FIRECRAWL_API_KEY',
      'REPLICATE_API_TOKEN',
      'CONTEXT7_API_KEY',
    ]) {
      expect(isForbiddenSandboxEnv(key)).toBe(true);
    }
  });

  it('forbids secret-shaped infra vars that may live in the server .env', () => {
    for (const key of [
      'STRIPE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DATABASE_URL',
      'ENCRYPTION_KEY',
      'SOME_PRIVATE_KEY',
      'MAILTRAP_API_TOKEN',
      'DAYTONA_API_KEY',
    ]) {
      expect(isForbiddenSandboxEnv(key)).toBe(true);
    }
  });

  it('allows the credentials we inject on purpose', () => {
    for (const key of [
      'KORTIX_TOKEN',
      'INTERNAL_SERVICE_KEY',
      'TUNNEL_TOKEN',
      'KORTIX_CLI_TOKEN',
      'KORTIX_EXECUTOR_TOKEN',
    ]) {
      expect(isForbiddenSandboxEnv(key)).toBe(false);
    }
  });

  it('allows KORTIX_API_URL and plain operational vars', () => {
    for (const key of [
      'KORTIX_API_URL',
      'PROJECT_ID',
      'KORTIX_WORKSPACE',
      'TZ',
    ]) {
      expect(isForbiddenSandboxEnv(key)).toBe(false);
    }
  });
});
