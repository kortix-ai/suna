import { expect, test } from 'bun:test';
import { manifestConfigDir } from './manifest-config-dir';

test.each(['pi', 'opencode'])('normalizes the legacy %s config directory', (runtime) => {
  expect(manifestConfigDir({ [runtime]: { config_dir: ' .kortix/config/// ' } })).toBe('.kortix/config');
  expect(manifestConfigDir({ [runtime]: { config_dir: '/' } })).toBe('');
});

test('handles long internal slash runs without repeated suffix searches', () => {
  const directory = `.kortix/${'/'.repeat(50_000)}config`;
  const started = performance.now();
  expect(manifestConfigDir({ pi: { config_dir: directory } })).toBe(directory);
  expect(performance.now() - started).toBeLessThan(100);
});

test('shared config takes precedence and retains its validation', () => {
  expect(manifestConfigDir({ config_dir: '.shared', pi: { config_dir: '.legacy' } })).toBe('.shared');
  expect(() => manifestConfigDir({ config_dir: '../outside' })).toThrow('repository-relative');
});
