import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVIDER_CATALOG_ID,
  PROVIDER_ENV_VARS,
  coolingSecrets,
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
  test('bedrock shows connected with just bearer token + region set (the sampleco case)', () => {
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

describe('runProviders rejects what it does not know', () => {
  // A rejection must fire before any command runs: strip every auth source
  // (config file, injected sandbox env and its env file, ambient token), so a
  // pass-through would end in project resolution (exit 1), never the usage
  // error — and never a network call.
  const saved: Record<string, string | undefined> = {};
  const keys = [
    'KORTIX_CONFIG_FILE',
    'KORTIX_TOKEN',
    'KORTIX_API_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  ] as const;
  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.KORTIX_CONFIG_FILE = join(
      tmpdir(),
      `kortix-providers-flags-${process.pid}`,
      'missing.json',
    );
    delete process.env.KORTIX_TOKEN;
    delete process.env.KORTIX_API_URL;
    delete process.env.KORTIX_PROJECT_ID;
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  });
  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function runExpectingStderr(argv: string[]): Promise<{ code: number; stderr: string }> {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runProviders(argv);
    } finally {
      process.stderr.write = orig;
    }
    return { code, stderr: chunks.join('') };
  }

  test('ls --available errors with the usage and exit 2, before project resolution', async () => {
    const { code, stderr } = await runExpectingStderr(['ls', '--available']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option "--available"');
    expect(stderr).toContain('Usage: kortix providers');
  });

  test('ls takes no positional either', async () => {
    const { code, stderr } = await runExpectingStderr(['ls', 'extra']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option "extra"');
  });

  test('known flags still reach the command layer', async () => {
    const { code, stderr } = await runExpectingStderr(['ls', '--json', '--project', 'p1']);
    expect(code).not.toBe(2);
    expect(stderr).not.toContain('unknown option');
  });

  test('set rejects an unknown flag before any network call', async () => {
    const { code, stderr } = await runExpectingStderr([
      'set',
      'anthropic',
      'sk-ant-synthetic',
      '--bogus',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option "--bogus"');
    expect(stderr).toContain('Usage: kortix providers');
  });

  test('login rejects an unknown flag with the login usage', async () => {
    const { code, stderr } = await runExpectingStderr(['login', 'openai', '--bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option "--bogus"');
    expect(stderr).toContain('Usage: kortix providers login <provider>');
  });

  // KRTX-2990: the API's device flow serves openai, opencode and opencode-go
  // only (provider-oauth.ts oauthProvider), and nothing reads enterprise_url.
  test('login github-copilot fails fast and names the supported providers', async () => {
    const { code, stderr } = await runExpectingStderr(['login', 'github-copilot']);
    expect(code).toBe(2);
    expect(stderr).toContain('OAuth not supported for "github-copilot"');
    expect(stderr).toContain('openai, opencode, opencode-go');
    expect(stderr).not.toContain('providers set github-copilot');
  });

  test('login --enterprise is an unknown option', async () => {
    const { code, stderr } = await runExpectingStderr([
      'login',
      'openai',
      '--enterprise',
      'https://ghe.example.test',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option "--enterprise"');
    expect(stderr).not.toContain('github-copilot');
  });
});

describe('provider positional help', () => {
  test('login <provider> --help short-circuits before project resolution and OAuth', async () => {
    const chunks: string[] = [];
    const errors: string[] = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    (process.stdout as any).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    (process.stderr as any).write = (chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    };
    try {
      const code = await runProviders(['login', 'openai', '--help']);
      expect(code).toBe(0);
    } finally {
      (process.stdout as any).write = stdout;
      (process.stderr as any).write = stderr;
    }
    expect(chunks.join('')).toContain('Usage: kortix providers login <provider>');
    expect(errors.join('')).toBe('');
  });
});

describe('providers retry — which stored accounts end their cooldown', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const rows = [
    { secret_id: 'a', label: 'ChatGPT A', provider_id: 'codex', cooldown_until: '2026-10-10T00:00:00Z' },
    { secret_id: 'b', label: 'ChatGPT B', provider_id: 'codex', cooldown_until: null },
    { secret_id: 'c', label: 'Old rest', provider_id: 'codex', cooldown_until: '2026-10-01T00:00:00Z' },
    { secret_id: 'd', label: 'Anthropic', provider_id: 'anthropic', cooldown_until: '2026-10-06T13:00:00Z' },
  ];
  test('only accounts still cooling down; openai, chatgpt and codex all name ChatGPT connections', () => {
    for (const name of ['openai', 'chatgpt', 'codex']) expect(coolingSecrets(rows, name, now).map((r) => r.secret_id)).toEqual(['a']);
  });
  test('with no provider, every cooling account', () => {
    expect(coolingSecrets(rows, undefined, now).map((r) => r.secret_id)).toEqual(['a', 'd']);
  });
});
