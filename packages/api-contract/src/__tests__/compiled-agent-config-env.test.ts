import { describe, expect, test } from 'bun:test';
import {
  COMPILED_AGENT_CONFIG_ENV,
  COMPILED_AGENT_CONFIG_GZ_PARTS_ENV,
  CompiledAgentConfigEnvError,
  CompiledAgentConfigTooLargeError,
  MAX_COMPILED_AGENT_CONFIG_GZ_PARTS,
  MAX_ENV_STRING_BYTES,
  compiledAgentConfigGzPartEnv,
  encodeCompiledAgentConfigEnv,
  envStringBytes,
  fitsInEnvString,
  readCompiledAgentConfigEnv,
  writeCompiledAgentConfigEnv,
} from '../compiled-agent-config-env';

// Platinum prod, 7 days to 2026-10-14, measured as `KORTIX_COMPILED_AGENT_CONFIG=<json>\0`
// (kortix-ai/platinum#1569): every create at or above the smallest failing size
// failed, every create at or below the largest booting size booted.
const PROD_SMALLEST_FAILING = 131_734;
const PROD_LARGEST_FAILING = 269_979;
const PROD_LARGEST_BOOTING = 115_720;

/** Deterministic PRNG, so a failure reproduces byte for byte. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = (
  'agent repository branch commit review deploy customer ticket refund invoice order shipment warehouse ' +
  'policy escalate summarize verify confirm reproduce investigate migrate schema index query latency ' +
  'incident runbook alert dashboard metric threshold rollback release staging production sandbox secret ' +
  'credential token scope permission approve deny ask tool shell edit read write search fetch browse ' +
  'always never before after unless when every only first then finally carefully briefly clearly ' +
  'the a an of to in on for with from by into over under between within without about against ' +
  'you must should may will can cannot do not keep report explain cite quote link attach include ' +
  'markdown table list heading section paragraph example template checklist step plan goal constraint'
).split(' ');

/** Prompt-like prose: sentences, no characters JSON escapes, so its length is its byte count. */
function prose(seed: number, chars: number): string {
  const random = mulberry32(seed);
  let out = '';
  while (out.length < chars) {
    const words = 6 + Math.floor(random() * 14);
    const sentence: string[] = [];
    for (let i = 0; i < words; i++) sentence.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)]!);
    const text = sentence.join(' ');
    out += `${text[0]!.toUpperCase()}${text.slice(1)}. `;
  }
  return out.slice(0, chars);
}

/** A compiled agent the way compile-agent-config.ts emits one. */
function agent(index: number, promptChars: number) {
  return {
    description: prose(index * 7 + 1, 120),
    mode: index === 0 ? 'primary' : 'subagent',
    model: 'kortix/claude-sonnet-5',
    prompt: prose(index * 7 + 2, promptChars),
    tools: { '*': true, bash: index % 3 !== 0, webfetch: index % 2 === 0 },
    permission: {
      edit: index % 2 === 0 ? 'allow' : 'ask',
      bash: { 'git push*': 'deny', 'rm -rf*': 'deny', '*': 'allow' },
      skill: { deploy: index === 0 ? 'allow' : 'deny', '*': 'allow' },
    },
  };
}

/**
 * Realistic compiled agent config JSON whose `KORTIX_COMPILED_AGENT_CONFIG=<json>\0`
 * is exactly `envBytes` long: agents of about 18 KB each, then one more whose
 * prompt takes up the remainder.
 */
function compiledConfigWithEnvStringBytes(envBytes: number): string {
  const config = {
    model: 'kortix/claude-sonnet-5',
    default_agent: 'agent-0',
    agent: {} as Record<string, ReturnType<typeof agent>>,
    kortix_tools: ['web_search', 'image_search', 'scrape_webpage', 'memory'],
    project_tools: { lookup_order: 'tools/lookup-order.ts', refund: 'tools/refund.ts' },
    skills: { paths: ['/workspace/skills', '/opt/kortix/managed-skills'] },
  };
  const size = () => envStringBytes(COMPILED_AGENT_CONFIG_ENV, JSON.stringify(config));
  let index = 0;
  while (size() < envBytes - 20_000) config.agent[`agent-${index}`] = agent(index++, 18_000);
  config.agent[`agent-${index}`] = agent(index, 0);
  const deficit = envBytes - size();
  if (deficit < 0) throw new Error(`fixture overshot ${envBytes}`);
  config.agent[`agent-${index}`]!.prompt = prose(9_999, deficit);
  const json = JSON.stringify(config);
  if (envStringBytes(COMPILED_AGENT_CONFIG_ENV, json) !== envBytes) throw new Error('fixture is not exact');
  return json;
}

function everyEnvStringFits(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    expect(envStringBytes(name, value), name).toBeLessThanOrEqual(MAX_ENV_STRING_BYTES);
  }
}

describe('the exec limit', () => {
  test('counts NAME=VALUE plus the NUL, in UTF-8 bytes', () => {
    expect(envStringBytes('A', 'bc')).toBe(5);
    // Two UTF-16 units, four UTF-8 bytes: execve counts the bytes.
    expect(envStringBytes('A', '\u{1F600}')).toBe(7);
  });

  test('a value fits up to exactly 131,072 bytes and not one byte more', () => {
    const name = COMPILED_AGENT_CONFIG_ENV;
    const atLimit = 'x'.repeat(MAX_ENV_STRING_BYTES - name.length - 2);
    expect(envStringBytes(name, atLimit)).toBe(131_072);
    expect(fitsInEnvString(name, atLimit)).toBe(true);
    expect(fitsInEnvString(name, `${atLimit}x`)).toBe(false);
  });

  test('a multi-byte value that fits in UTF-16 units but not in bytes is over', () => {
    const name = COMPILED_AGENT_CONFIG_ENV;
    const value = '\u00e9'.repeat(70_000); // 70,000 units, 140,000 bytes
    expect(value.length + name.length + 2).toBeLessThan(MAX_ENV_STRING_BYTES);
    expect(fitsInEnvString(name, value)).toBe(false);
  });
});

describe('old-format passthrough', () => {
  test('a config that fits is the raw var, byte for byte, and nothing else', () => {
    for (const json of ['{"agent":{}}', compiledConfigWithEnvStringBytes(PROD_LARGEST_BOOTING)]) {
      expect(encodeCompiledAgentConfigEnv(json)).toEqual({ [COMPILED_AGENT_CONFIG_ENV]: json });
    }
  });

  test('the largest config prod booted stays raw', () => {
    const json = compiledConfigWithEnvStringBytes(PROD_LARGEST_BOOTING);
    expect(envStringBytes(COMPILED_AGENT_CONFIG_ENV, json)).toBe(PROD_LARGEST_BOOTING);
    expect(Object.keys(encodeCompiledAgentConfigEnv(json))).toEqual([COMPILED_AGENT_CONFIG_ENV]);
  });

  test('exactly at the limit stays raw; one byte over switches form', () => {
    const atLimit = compiledConfigWithEnvStringBytes(MAX_ENV_STRING_BYTES);
    expect(Object.keys(encodeCompiledAgentConfigEnv(atLimit))).toEqual([COMPILED_AGENT_CONFIG_ENV]);
    const over = compiledConfigWithEnvStringBytes(MAX_ENV_STRING_BYTES + 1);
    const env = encodeCompiledAgentConfigEnv(over);
    expect(env).not.toHaveProperty(COMPILED_AGENT_CONFIG_ENV);
    expect(env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]).toBe('1');
    expect(readCompiledAgentConfigEnv(env)).toBe(over);
  });

  test('the reader returns a raw value as it is, and an empty or absent one unchanged', () => {
    const json = '{"agent":{"build":{}}}';
    expect(readCompiledAgentConfigEnv({ [COMPILED_AGENT_CONFIG_ENV]: json })).toBe(json);
    expect(readCompiledAgentConfigEnv({})).toBeUndefined();
    expect(readCompiledAgentConfigEnv({ [COMPILED_AGENT_CONFIG_ENV]: '' })).toBe('');
    // Not JSON is the reader's caller's problem, exactly as before.
    expect(readCompiledAgentConfigEnv({ [COMPILED_AGENT_CONFIG_ENV]: 'not json{' })).toBe('not json{');
  });

  test('a non-empty raw value wins over a gzip form beside it', () => {
    const env = { ...encodeCompiledAgentConfigEnv(compiledConfigWithEnvStringBytes(PROD_SMALLEST_FAILING)) };
    env[COMPILED_AGENT_CONFIG_ENV] = '{"agent":{}}';
    expect(readCompiledAgentConfigEnv(env)).toBe('{"agent":{}}');
  });
});

describe("prod's failing sizes", () => {
  test.each([PROD_SMALLEST_FAILING, PROD_LARGEST_FAILING])(
    '%d bytes of realistic JSON travels gzipped, every env string fits, and reads back exactly',
    (envBytes) => {
      const json = compiledConfigWithEnvStringBytes(envBytes);
      expect(envStringBytes(COMPILED_AGENT_CONFIG_ENV, json)).toBe(envBytes);
      expect(fitsInEnvString(COMPILED_AGENT_CONFIG_ENV, json)).toBe(false);

      const env = encodeCompiledAgentConfigEnv(json);
      expect(env).not.toHaveProperty(COMPILED_AGENT_CONFIG_ENV);
      everyEnvStringFits(env);
      // Gzip takes realistic agent JSON far under one part.
      expect(env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]).toBe('1');
      expect(envStringBytes(compiledAgentConfigGzPartEnv(0), env[compiledAgentConfigGzPartEnv(0)]!)).toBeLessThan(
        envBytes / 2,
      );

      const decoded = readCompiledAgentConfigEnv(env);
      expect(decoded).toBe(json);
      expect(JSON.parse(decoded!).default_agent).toBe('agent-0');
    },
  );
});

describe('round trip', () => {
  test('an incompressible config splits into several parts, each fits, and joins back exactly', () => {
    const random = mulberry32(42);
    const noise = Array.from({ length: 300_000 }, () => String.fromCharCode(33 + Math.floor(random() * 90)))
      .join('')
      .replace(/["\\]/g, '_');
    const json = JSON.stringify({ agent: { build: { prompt: noise } } });
    const env = encodeCompiledAgentConfigEnv(json);
    const parts = Number(env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]);
    expect(parts).toBeGreaterThan(1);
    expect(Object.keys(env)).toHaveLength(parts + 1);
    everyEnvStringFits(env);
    expect(readCompiledAgentConfigEnv(env)).toBe(json);
  });

  test('UTF-8 content survives', () => {
    const json = JSON.stringify({ agent: { build: { prompt: 'R\u00e9ponds en fran\u00e7ais. \u{1F600} '.repeat(10_000) } } });
    expect(readCompiledAgentConfigEnv(encodeCompiledAgentConfigEnv(json))).toBe(json);
  });

  test('a config no environment can carry is refused, not truncated', () => {
    const random = mulberry32(7);
    const noise = Array.from({ length: 2_000_000 }, () => String.fromCharCode(48 + Math.floor(random() * 75)))
      .join('')
      .replace(/["\\]/g, '_');
    expect(() => encodeCompiledAgentConfigEnv(JSON.stringify({ agent: { build: { prompt: noise } } }))).toThrow(
      CompiledAgentConfigTooLargeError,
    );
  });
});

describe('a damaged gzip form throws instead of reading as no config', () => {
  const env = () => ({ ...encodeCompiledAgentConfigEnv(compiledConfigWithEnvStringBytes(PROD_SMALLEST_FAILING)) });

  test('a missing part', () => {
    const damaged = { ...env(), [COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]: '2' };
    expect(() => readCompiledAgentConfigEnv(damaged)).toThrow(CompiledAgentConfigEnvError);
  });

  test.each(['0', '-1', '1.5', 'abc', String(MAX_COMPILED_AGENT_CONFIG_GZ_PARTS + 1)])('a part count of %p', (count) => {
    expect(() => readCompiledAgentConfigEnv({ ...env(), [COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]: count })).toThrow(
      CompiledAgentConfigEnvError,
    );
  });

  test('corrupt bytes', () => {
    const damaged = env();
    const part = damaged[compiledAgentConfigGzPartEnv(0)]!;
    damaged[compiledAgentConfigGzPartEnv(0)] = `${part.slice(0, 200)}AAAA${part.slice(204)}`;
    expect(() => readCompiledAgentConfigEnv(damaged)).toThrow(CompiledAgentConfigEnvError);
  });
});

describe('writeCompiledAgentConfigEnv', () => {
  const big = compiledConfigWithEnvStringBytes(PROD_LARGEST_FAILING);
  const familyNames = (env: Record<string, string | undefined>) =>
    Object.keys(env)
      .filter((name) => name.startsWith(COMPILED_AGENT_CONFIG_ENV) && !name.endsWith('_ETAG'))
      .sort();

  test('switching form in either direction leaves no stale name behind', () => {
    const env: Record<string, string | undefined> = { OTHER: 'kept', KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'e' };

    writeCompiledAgentConfigEnv(env, '{"agent":{}}');
    expect(familyNames(env)).toEqual([COMPILED_AGENT_CONFIG_ENV]);

    writeCompiledAgentConfigEnv(env, big);
    expect(familyNames(env)).toEqual([compiledAgentConfigGzPartEnv(0), COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]);
    expect(readCompiledAgentConfigEnv(env)).toBe(big);

    writeCompiledAgentConfigEnv(env, '{"agent":{"b":{}}}');
    expect(familyNames(env)).toEqual([COMPILED_AGENT_CONFIG_ENV]);
    expect(readCompiledAgentConfigEnv(env)).toBe('{"agent":{"b":{}}}');

    writeCompiledAgentConfigEnv(env, null);
    expect(familyNames(env)).toEqual([]);
    expect(env).toEqual({ OTHER: 'kept', KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'e' });
  });

  test('a stale higher part from a longer config is removed', () => {
    const env: Record<string, string | undefined> = { [compiledAgentConfigGzPartEnv(5)]: 'stale' };
    writeCompiledAgentConfigEnv(env, big);
    expect(env).not.toHaveProperty(compiledAgentConfigGzPartEnv(5));
  });

  test('a config too large to carry leaves env exactly as it was', () => {
    const env: Record<string, string | undefined> = { [COMPILED_AGENT_CONFIG_ENV]: '{"agent":{}}' };
    const random = mulberry32(9);
    const noise = Array.from({ length: 2_000_000 }, () => String.fromCharCode(48 + Math.floor(random() * 75))).join('');
    expect(() => writeCompiledAgentConfigEnv(env, JSON.stringify({ p: noise.replace(/["\\]/g, '_') }))).toThrow(
      CompiledAgentConfigTooLargeError,
    );
    expect(env).toEqual({ [COMPILED_AGENT_CONFIG_ENV]: '{"agent":{}}' });
  });
});
