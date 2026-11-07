import { describe, expect, it } from 'vitest';
import { parseFlags } from '../src/core/flags';

describe('parseFlags', () => {
  it('reads --name value, --name=value and a bare --name, and keeps positionals in order', () => {
    const { positional, flags } = parseFlags(['run', '--id', 'ACC-4', 'extra', '--shard=2/4', '--dry-run']);
    expect(positional).toEqual(['run', 'extra']);
    expect(flags).toEqual({ id: 'ACC-4', shard: '2/4', 'dry-run': true });
  });

  it('never takes the next flag, an empty string or the end of argv as a value', () => {
    const { positional, flags } = parseFlags(['--a', '--b', '', '--c']);
    expect(flags).toEqual({ a: true, b: true, c: true });
    expect(positional).toEqual(['']);
  });

  it('keeps the text after the first = verbatim and the last value of a repeated flag', () => {
    expect(parseFlags(['--prompt=a=b', '--empty=', '--w', '2', '--w=3']).flags).toEqual({ prompt: 'a=b', empty: '', w: '3' });
  });

  it('value() returns the value, undefined when absent, and throws when the value is missing', () => {
    const { value } = parseFlags(['--target', 'https://example.test', '--token']);
    expect(value('target')).toBe('https://example.test');
    expect(value('sandbox-id')).toBeUndefined();
    expect(() => value('token')).toThrow('--token requires a value');
  });
});
