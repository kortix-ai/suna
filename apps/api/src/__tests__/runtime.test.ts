import { describe, expect, test } from 'bun:test';
import {
  parseRuntimeFlags,
  resolveEffectiveRuntime,
  runtimeEnvVars,
  executorDisabled,
  RUNTIME_FEATURES,
} from '../projects/runtime';

describe('parseRuntimeFlags', () => {
  test('empty / non-object → {}', () => {
    expect(parseRuntimeFlags(undefined)).toEqual({});
    expect(parseRuntimeFlags(null)).toEqual({});
    expect(parseRuntimeFlags('nope')).toEqual({});
  });

  test('reads disable_all (TOML) and disableAll (JSON)', () => {
    expect(parseRuntimeFlags({ disable_all: true }).disableAll).toBe(true);
    expect(parseRuntimeFlags({ disableAll: false }).disableAll).toBe(false);
  });

  test('flat per-feature booleans, coerced from strings/numbers', () => {
    expect(parseRuntimeFlags({ memory: false, web_tools: 'off', pty: 0, show: 'on' }).features).toEqual({
      memory: false,
      web_tools: false,
      pty: false,
      show: true,
    });
  });

  test('nested features table is honored', () => {
    expect(parseRuntimeFlags({ features: { memory: false } }).features).toEqual({ memory: false });
  });

  test('unknown keys and junk values are ignored', () => {
    const f = parseRuntimeFlags({ memory: false, bogus: true, pty: 'maybe' });
    expect(f.features).toEqual({ memory: false });
  });
});

describe('resolveEffectiveRuntime', () => {
  test('no config → all features ON, disable_all false', () => {
    const e = resolveEffectiveRuntime(undefined, undefined);
    expect(e.disableAll).toBe(false);
    for (const f of RUNTIME_FEATURES) expect(e.features[f]).toBe(true);
  });

  test('project default disables a feature', () => {
    const e = resolveEffectiveRuntime({ features: { memory: false } }, undefined);
    expect(e.features.memory).toBe(false);
    expect(e.features.pty).toBe(true);
  });

  test('session override wins over project default (enforce OFF)', () => {
    const e = resolveEffectiveRuntime({ features: { memory: true } }, { features: { memory: false } });
    expect(e.features.memory).toBe(false);
  });

  test('session override wins over project default (enforce ON)', () => {
    // project disabled memory, session forces it back on
    const e = resolveEffectiveRuntime({ features: { memory: false } }, { features: { memory: true } });
    expect(e.features.memory).toBe(true);
  });

  test('disable_all from project → everything off', () => {
    const e = resolveEffectiveRuntime({ disableAll: true }, undefined);
    expect(e.disableAll).toBe(true);
  });

  test('session can re-enable the whole runtime over a project disable_all', () => {
    const e = resolveEffectiveRuntime({ disableAll: true }, { disableAll: false });
    expect(e.disableAll).toBe(false);
  });
});

describe('runtimeEnvVars', () => {
  test('all-on default emits NOTHING (identical to legacy behavior)', () => {
    expect(runtimeEnvVars(resolveEffectiveRuntime(undefined, undefined))).toEqual({});
  });

  test('per-feature off emits only that flag', () => {
    const e = resolveEffectiveRuntime({ features: { memory: false, web_tools: false } }, undefined);
    expect(runtimeEnvVars(e)).toEqual({
      KORTIX_RUNTIME_MEMORY: 'off',
      KORTIX_RUNTIME_WEB_TOOLS: 'off',
    });
  });

  test('disable_all emits the master flag and subsumes per-feature flags', () => {
    const e = resolveEffectiveRuntime({ disableAll: true, features: { memory: false } }, undefined);
    expect(runtimeEnvVars(e)).toEqual({ KORTIX_RUNTIME_DISABLE_ALL: 'true' });
  });
});

describe('executorDisabled', () => {
  test('off when disable_all', () => {
    expect(executorDisabled(resolveEffectiveRuntime({ disableAll: true }, undefined))).toBe(true);
  });
  test('off when executor feature disabled', () => {
    expect(executorDisabled(resolveEffectiveRuntime({ features: { executor: false } }, undefined))).toBe(true);
  });
  test('on by default', () => {
    expect(executorDisabled(resolveEffectiveRuntime(undefined, undefined))).toBe(false);
  });
});

describe('end-to-end shape: kortix.toml [runtime] → env', () => {
  test('parse a TOML-ish [runtime] table → effective → env', () => {
    // what smol-toml would hand back for `manifest.raw.runtime`
    const tomlRuntime = { disable_all: false, memory: true, pty: false };
    const project = parseRuntimeFlags(tomlRuntime);
    const session = parseRuntimeFlags({ pty: true, show: false }); // session enforces
    const eff = resolveEffectiveRuntime(project, session);
    expect(eff.features.pty).toBe(true); // session re-enabled pty
    expect(eff.features.show).toBe(false); // session disabled show
    expect(runtimeEnvVars(eff)).toEqual({ KORTIX_RUNTIME_SHOW: 'off' });
  });
});
