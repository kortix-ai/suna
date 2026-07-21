import { describe, expect, test } from 'bun:test';

import {
  PROVIDER_CATALOG_ID,
  PROVIDER_ENV_VARS,
  isProviderConnected,
  runProviders,
} from '../commands/providers.ts';

describe('providers: bedrock mapping', () => {
  test('bedrock maps to the amazon-bedrock catalog id', () => {
    expect(PROVIDER_CATALOG_ID.bedrock).toBe('amazon-bedrock');
  });

  test('bedrock requires exactly the bearer token + region — not the SigV4 pair', () => {
    expect(PROVIDER_ENV_VARS.bedrock).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
  });

  test('every other known provider keeps its single-secret shape', () => {
    for (const name of [
      'anthropic',
      'openai',
      'openrouter',
      'google',
      'groq',
      'xai',
      'deepseek',
      'mistral',
    ]) {
      expect(PROVIDER_ENV_VARS[name]?.length, `${name} should need exactly one secret`).toBe(1);
    }
  });
});

describe('isProviderConnected — `providers ls` detection', () => {
  test('bedrock shows connected with just bearer token + region set (the essentia case)', () => {
    const secrets = new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
    expect(isProviderConnected(PROVIDER_ENV_VARS.bedrock!, secrets)).toBe(true);
  });

  test('bedrock does NOT show connected with only the bearer token', () => {
    const secrets = new Set(['AWS_BEARER_TOKEN_BEDROCK']);
    expect(isProviderConnected(PROVIDER_ENV_VARS.bedrock!, secrets)).toBe(false);
  });

  test('bedrock does NOT show connected from the unimplemented SigV4 pair alone', () => {
    const secrets = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']);
    expect(isProviderConnected(PROVIDER_ENV_VARS.bedrock!, secrets)).toBe(false);
  });

  test('a single-secret provider (anthropic) is unaffected', () => {
    expect(isProviderConnected(PROVIDER_ENV_VARS.anthropic!, new Set(['ANTHROPIC_API_KEY']))).toBe(
      true,
    );
    expect(isProviderConnected(PROVIDER_ENV_VARS.anthropic!, new Set())).toBe(false);
  });
});

describe('runProviders set — validation before any network call', () => {
  test('unknown provider errors with exit 2 and lists known providers including bedrock', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runProviders(['set', 'not-a-real-provider', 'x']);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(2);
    const out = chunks.join('');
    expect(out).toContain('Unknown provider');
    expect(out).toContain('bedrock');
  });

  test('bedrock without --region (and no TTY to prompt) errors with exit 2, before touching the network', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runProviders(['set', 'bedrock', 'sometoken']);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(2);
    expect(chunks.join('')).toContain('--region');
  });
});

describe('runProviders login — github-copilot is removed dead CLI surface', () => {
  // The server has never implemented OAuth for github-copilot (it 400s the
  // request) — `login github-copilot` used to reach the network and print a
  // raw HTTP 400. It must now fail client-side, with no network call, before
  // ever resolving a project/auth context (docs/specs/2026-07-21-cli-
  // credential-model-ux.md §1.1.2).
  test('errors with exit 2 and does not require login/project context', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runProviders(['login', 'github-copilot']);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(2);
    const out = chunks.join('');
    expect(out).toContain('github-copilot');
    expect(out).not.toContain('HTTP 400');
  });

  test('openai remains the only OAuth login provider in --help output', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    try {
      await runProviders(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    expect(out).not.toContain('github-copilot');
  });
});
