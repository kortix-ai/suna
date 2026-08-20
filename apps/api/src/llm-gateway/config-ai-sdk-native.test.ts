import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// GAP-B (config): `config.aiSdkNative` reads env `GATEWAY_AI_SDK_NATIVE` and
// maps on/off/default. `config` is a validated singleton evaluated once at
// import, so each case runs in a FRESH subprocess with a different env value —
// the only deterministic way to exercise the env→flag mapping.
//
// The current process already loaded scripts/test.env (the fake-value hermetic
// env), so `process.env` here carries every var `config` needs to validate.
// Each subprocess inherits it and only `GATEWAY_AI_SDK_NATIVE` differs.

const API_ROOT = join(import.meta.dir, '..', '..');
const CONFIG_PATH = join(API_ROOT, 'src', 'config.ts');

async function readAiSdkNative(value: string | undefined): Promise<boolean> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (value === undefined) delete env.GATEWAY_AI_SDK_NATIVE;
  else env.GATEWAY_AI_SDK_NATIVE = value;

  const proc = Bun.spawn(
    [
      'bun',
      // Mirrors scripts/test.sh: --env-file loads the hermetic fake-value env
      // AND stops bun auto-loading the dotenvx-encrypted .env (whose
      // `encrypted:…` values would fail config validation). GATEWAY_AI_SDK_NATIVE
      // is absent from test.env, so the value passed via `env` is the only
      // source for it.
      '--env-file=scripts/test.env',
      '-e',
      // config validation logs to stdout, so wrap the value in sentinels and
      // extract it rather than parsing the whole stream.
      `const { config } = await import(${JSON.stringify(CONFIG_PATH)}); process.stdout.write("<<<"+JSON.stringify(config.aiSdkNative)+">>>");`,
    ],
    { env, cwd: API_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`config subprocess exited ${code}: ${err}`);
  }
  const match = out.match(/<<<(.+?)>>>/);
  if (!match) throw new Error(`no result sentinel in config subprocess output: ${out}`);
  return JSON.parse(match[1]) as boolean;
}

describe('config.aiSdkNative — GATEWAY_AI_SDK_NATIVE parsing', () => {
  test('default (unset) → true (native is the default everywhere)', async () => {
    expect(await readAiSdkNative(undefined)).toBe(true);
  });

  test('"true" → true', async () => {
    expect(await readAiSdkNative('true')).toBe(true);
  });

  test('"1" → true', async () => {
    expect(await readAiSdkNative('1')).toBe(true);
  });

  test('"false" → false', async () => {
    expect(await readAiSdkNative('false')).toBe(false);
  });
});
