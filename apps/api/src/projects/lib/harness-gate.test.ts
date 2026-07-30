import { describe, expect, test } from 'bun:test';
import { HARNESSES, HARNESS_IDS } from '@kortix/shared/harnesses';

import { config } from '../../config';
import {
  enabledHarnessIds,
  harnessNotEnabledError,
  isHarnessEnabled,
  stableHarnessIds,
} from './harness-gate';

describe('stableHarnessIds', () => {
  test('is derived from the shared descriptor table, not a local literal', () => {
    expect(stableHarnessIds()).toEqual(
      HARNESS_IDS.filter((id) => HARNESSES[id].stability === 'stable'),
    );
  });

  test('resolves to opencode alone today', () => {
    expect(stableHarnessIds()).toEqual(['opencode']);
  });
});

describe('enabledHarnessIds', () => {
  test('an unset allowlist enables the stable set only', () => {
    for (const raw of [undefined, null, '', '   ', ',,', ' , ']) {
      expect(enabledHarnessIds(raw)).toEqual(['opencode']);
    }
  });

  test('an explicit allowlist adds the named experimental harnesses', () => {
    expect(enabledHarnessIds('claude')).toEqual(['claude', 'opencode']);
    expect(enabledHarnessIds('opencode,claude,codex,pi')).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);
  });

  test('keeps the shared presentation order regardless of input order', () => {
    expect(enabledHarnessIds('pi,claude')).toEqual(['claude', 'opencode', 'pi']);
  });

  test('tolerates whitespace, case, and duplicates', () => {
    expect(enabledHarnessIds(' Claude , claude ,CODEX ')).toEqual(['claude', 'codex', 'opencode']);
  });

  test('ignores an unknown harness name instead of failing open', () => {
    expect(enabledHarnessIds('cursor,aider')).toEqual(['opencode']);
    expect(enabledHarnessIds('claude,cursor')).toEqual(['claude', 'opencode']);
  });

  test('never lets an operator lock the stable harness out', () => {
    expect(enabledHarnessIds('claude')).toContain('opencode');
    expect(enabledHarnessIds('none')).toEqual(['opencode']);
  });
});

describe('isHarnessEnabled', () => {
  test('opencode is enabled on the stable path', () => {
    expect(isHarnessEnabled('opencode', '')).toBe(true);
  });

  test('claude, codex, and pi are refused on the stable path', () => {
    for (const harness of ['claude', 'codex', 'pi']) {
      expect(isHarnessEnabled(harness, '')).toBe(false);
    }
  });

  test('the kill switch opens and closes an experimental harness', () => {
    expect(isHarnessEnabled('claude', 'opencode,claude')).toBe(true);
    expect(isHarnessEnabled('claude', 'opencode')).toBe(false);
  });

  test('a non-harness value is never enabled', () => {
    expect(isHarnessEnabled('cursor', 'opencode,claude,codex,pi')).toBe(false);
    expect(isHarnessEnabled(null, 'opencode,claude,codex,pi')).toBe(false);
    expect(isHarnessEnabled(undefined, 'opencode,claude,codex,pi')).toBe(false);
  });

  test('the shipped default closes every experimental harness', () => {
    expect(isHarnessEnabled('opencode', config.KORTIX_ENABLED_HARNESSES)).toBe(true);
    for (const harness of ['claude', 'codex', 'pi']) {
      expect(isHarnessEnabled(harness, config.KORTIX_ENABLED_HARNESSES)).toBe(false);
    }
  });
});

describe('harnessNotEnabledError', () => {
  test('names the harness and the env var that opens it', () => {
    const error = harnessNotEnabledError('claude');

    expect(error.status).toBe(409);
    expect(error.body.code).toBe('HARNESS_NOT_ENABLED');
    expect(error.body.error).toContain('Claude Code');
    expect(error.body.error).toContain('KORTIX_ENABLED_HARNESSES');
  });

  test('never silently downgrades to opencode', () => {
    expect(harnessNotEnabledError('pi').body.error).not.toContain('OpenCode');
  });
});
