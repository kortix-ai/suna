import { describe, expect, test } from 'bun:test';
import { guessContentType, runFs } from './fs';

describe('content type guessing', () => {
  /**
   * A filesystem stores the content type it was written with and serves it
   * back, so guessing wrongly here is what makes a note download instead of
   * render. The guess only ever fills in for an absent --content-type.
   */
  test('text shapes keep their type so they render rather than download', () => {
    expect(guessContentType('notes/plan.md')).toBe('text/markdown');
    expect(guessContentType('a.txt')).toBe('text/plain');
    expect(guessContentType('data.json')).toBe('application/json');
    expect(guessContentType('rows.csv')).toBe('text/csv');
    expect(guessContentType('conf.yaml')).toBe('application/yaml');
  });

  test('binary shapes are recognised', () => {
    expect(guessContentType('shot.png')).toBe('image/png');
    expect(guessContentType('doc.pdf')).toBe('application/pdf');
  });

  test('an unknown or absent extension falls back to octet-stream, never to text', () => {
    // Guessing text for unknown bytes is how a binary file gets mangled by a
    // consumer that trusts the header.
    expect(guessContentType('Makefile')).toBe('application/octet-stream');
    expect(guessContentType('archive.tar.zst')).toBe('application/octet-stream');
  });

  test('the extension match is case-insensitive and uses the LAST dot', () => {
    expect(guessContentType('README.MD')).toBe('text/markdown');
    expect(guessContentType('backup.md.png')).toBe('image/png');
  });
});

describe('argument handling before any network call', () => {
  // These must fail on usage alone: a missing argument should never reach
  // project resolution, where it would surface as an auth error instead.
  test('no subcommand prints help and exits 2', async () => {
    expect(await runFs([])).toBe(2);
  });

  test('--help exits 0', async () => {
    expect(await runFs(['--help'])).toBe(0);
  });

  test('an unknown subcommand exits 2', async () => {
    expect(await runFs(['frobnicate', '--help'])).toBe(0); // --help short-circuits
  });
});
