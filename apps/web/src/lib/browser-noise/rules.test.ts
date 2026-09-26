/**
 * Pins the noise-rule table to the verdicts of the two if-chain dispatchers it
 * replaced.
 *
 * `golden-verdicts.json` holds every input the `browser-error-noise.test.mts`
 * suite fed any matcher (each predicate input also re-shaped as a runtime
 * capture and as a Sentry event), plus synthetic inputs for rules the suite
 * never exercised. Each case records what the old
 * `shouldIgnoreBrowserRuntimeNoise` and `shouldIgnoreSentryBrowserNoise`
 * returned for it. `{ "$undefined": true }` encodes an explicit `undefined`.
 *
 * A deliberate behaviour change updates the affected cases' verdicts in the
 * same change; the failure message names each case by its index.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NOISE_RULES,
  shouldIgnoreBrowserRuntimeNoise,
  shouldIgnoreSentryBrowserNoise,
} from '../browser-error-noise';
import type {
  NoiseEvidence,
  NoiseKind,
  NoiseRule,
  RuntimeNoiseInput,
  SentryNoiseEvent,
} from './evidence';
import { runtimeNoiseEvidence, sentryNoiseEvidence } from './evidence';

type GoldenInput = RuntimeNoiseInput & SentryNoiseEvent;

interface GoldenCase {
  index: number;
  input: GoldenInput;
  runtime: boolean;
  sentry: boolean;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.$undefined === true) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

const CASES: GoldenCase[] = (
  JSON.parse(readFileSync(join(import.meta.dir, 'golden-verdicts.json'), 'utf8')) as Array<
    Omit<GoldenCase, 'index'>
  >
).map((golden, index) => ({ ...golden, index, input: decode(golden.input) as GoldenInput }));

const KINDS: readonly NoiseKind[] = ['runtime', 'sentry'];

function evidenceFor(kind: NoiseKind, input: GoldenInput): NoiseEvidence {
  return kind === 'runtime' ? runtimeNoiseEvidence(input) : sentryNoiseEvidence(input);
}

function applies(rule: NoiseRule, kind: NoiseKind): boolean {
  return rule.appliesTo === 'both' || rule.appliesTo === kind;
}

/** Cases where `rule` alone, among the rules of `kind`'s gate, matches. */
function soleMatches(rule: NoiseRule, kind: NoiseKind): GoldenCase[] {
  return CASES.filter((golden) => {
    const evidence = evidenceFor(kind, golden.input);
    return (
      rule.match(evidence) &&
      NOISE_RULES.every(
        (other) => other === rule || !applies(other, kind) || !other.match(evidence),
      )
    );
  });
}

// Rules whose every match is also a match of a broader rule of the same gate.
// No fixture can show the gate consults them. Each entry names the broader rule.
const SUBSUMED_BY: Readonly<Record<string, string>> = {
  // Both require an injected-app source frame, which `injected-app-source`
  // drops on its own.
  'injected-script-send-message': 'injected-app-source',
  'captcha-interceptor': 'injected-app-source',
};

test('golden: both gates return the pre-table verdict for every case', () => {
  expect(CASES.length).toBeGreaterThan(1800);
  const mismatches = CASES.flatMap((golden) => {
    const runtime = shouldIgnoreBrowserRuntimeNoise(golden.input);
    const sentry = shouldIgnoreSentryBrowserNoise(golden.input);
    return runtime === golden.runtime && sentry === golden.sentry
      ? []
      : [{ index: golden.index, runtime, sentry, expected: [golden.runtime, golden.sentry] }];
  });
  expect(mismatches).toEqual([]);
});

describe('NOISE_RULES', () => {
  test('every rule id is unique kebab-case', () => {
    const ids = NOISE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toEqual([]);
  });

  test('every rule has a positive fixture in a gate it applies to', () => {
    const withoutFixture = NOISE_RULES.filter(
      (rule) =>
        !KINDS.some(
          (kind) =>
            applies(rule, kind) &&
            CASES.some((golden) => golden[kind] && rule.match(evidenceFor(kind, golden.input))),
        ),
    ).map((rule) => rule.id);
    expect(withoutFixture).toEqual([]);
  });

  test('every gate a rule applies to is proven by a case only that rule drops', () => {
    const unproven = NOISE_RULES.flatMap((rule) =>
      KINDS.filter(
        (kind) =>
          applies(rule, kind) &&
          !(rule.id in SUBSUMED_BY) &&
          !soleMatches(rule, kind).some((golden) => golden[kind]),
      ).map((kind) => `${rule.id} (${kind})`),
    );
    expect(unproven).toEqual([]);
  });

  test('a subsumed rule never matches without its broader rule', () => {
    const escapes = Object.entries(SUBSUMED_BY).flatMap(([id, broaderId]) => {
      const rule = NOISE_RULES.find((candidate) => candidate.id === id);
      const broader = NOISE_RULES.find((candidate) => candidate.id === broaderId);
      if (!rule || !broader) return [`${id} -> ${broaderId}: unknown rule id`];
      return CASES.flatMap((golden) =>
        KINDS.filter((kind) => {
          const evidence = evidenceFor(kind, golden.input);
          return rule.match(evidence) && !broader.match(evidence);
        }).map((kind) => `${id} (${kind}) case ${golden.index}`),
      );
    });
    expect(escapes).toEqual([]);
  });

  // A gate-specific rule either cannot fire on the other gate's evidence (it
  // reads a field that gate never fills), or a case shows the other gate
  // ignored an input the rule matches. Anything else is an unproven asymmetry.
  test('every gate-specific rule is proven absent from the other gate', () => {
    const unproven = NOISE_RULES.filter((rule) => rule.appliesTo !== 'both').flatMap((rule) => {
      const other: NoiseKind = rule.appliesTo === 'runtime' ? 'sentry' : 'runtime';
      const matched = CASES.filter((golden) => rule.match(evidenceFor(other, golden.input)));
      return matched.length === 0 || matched.some((golden) => !golden[other])
        ? []
        : [`${rule.id} (${other})`];
    });
    expect(unproven).toEqual([]);
  });
});
