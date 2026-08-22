import { describe, expect, test } from 'bun:test';
import {
  parseSessionOverrides,
  type SessionOverrides,
} from '../commands/sessions.ts';

type IsNever<T> = [T] extends [never] ? true : false;
type SessionAttributionKey = Extract<keyof SessionOverrides, `${'endUser' | 'origin'}Ref`>;

describe('parseSessionOverrides', () => {
  test('parses the full backend override set and consumes the flags', () => {
    const argv = [
      '--model',
      'anthropic/claude-opus-4-8',
      '--secret',
      'GMAIL_TOKEN',
      '--secret',
      'STRIPE_KEY',
      '--connector',
      'gmail=prof-1',
      '--require-connector',
      'gmail',
      '--require-connector',
      'gmail',
      '--context',
      'tier=pro',
      'positional',
    ];
    const out = parseSessionOverrides(argv);
    expect(out).toEqual({
      model: 'anthropic/claude-opus-4-8',
      secrets: ['GMAIL_TOKEN', 'STRIPE_KEY'],
      connectors: { gmail: { connection_id: 'prof-1' } },
      requiredConnectors: ['gmail'],
      runtimeContext: { tier: 'pro' },
    });
    // Only the override flags are consumed; the positional survives.
    expect(argv).toEqual(['positional']);
  });

  test('omits usage attribution from the override contract', () => {
    const omitted: IsNever<SessionAttributionKey> = true;
    expect(omitted).toBe(true);
  });

  test('leaves removed attribution flags unconsumed', () => {
    const removedFlag = ['--', 'origin', '-ref'].join('');
    const argv = [removedFlag, 'customer-42'];
    expect(parseSessionOverrides(argv)).toEqual({});
    expect(argv).toEqual([removedFlag, 'customer-42']);
  });

  test('is empty when no override flags are present', () => {
    const argv = ['--prompt', 'hi'];
    expect(parseSessionOverrides(argv)).toEqual({});
    expect(argv).toEqual(['--prompt', 'hi']);
  });

  test('accepts the --flag=value form and repeated connectors', () => {
    const out = parseSessionOverrides([
      '--model=gpt-x',
      '--connector=gmail=p1',
      '--connector=slack=p2',
    ]);
    expect(out.model).toBe('gpt-x');
    expect(out.connectors).toEqual({
      gmail: { connection_id: 'p1' },
      slack: { connection_id: 'p2' },
    });
  });

  test('rejects a malformed --connector / --context pair', () => {
    expect(() => parseSessionOverrides(['--connector', 'noeq'])).toThrow(
      /alias=connection_id/,
    );
    expect(() => parseSessionOverrides(['--context', 'noeq'])).toThrow(/key=value/);
  });

  test('--no-secrets narrows to zero secrets (distinct from omitting the field)', () => {
    expect(parseSessionOverrides(['--no-secrets']).secrets).toEqual([]);
    expect(parseSessionOverrides([]).secrets).toBeUndefined();
  });

  test('rejects --secret together with --no-secrets', () => {
    expect(() => parseSessionOverrides(['--secret', 'X', '--no-secrets'])).toThrow(/not both/);
  });

  test('--no-connectors creates an explicit empty binding map', () => {
    expect(parseSessionOverrides(['--no-connectors']).connectors).toEqual({});
    expect(parseSessionOverrides([]).connectors).toBeUndefined();
  });

  test('rejects --connector together with --no-connectors', () => {
    expect(() =>
      parseSessionOverrides(['--connector', 'gmail=prof-1', '--no-connectors']),
    ).toThrow(/not both/);
  });
});
