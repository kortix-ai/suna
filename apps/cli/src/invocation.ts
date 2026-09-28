import { basename } from 'node:path';

/**
 * `kortixt` is `kortix t`: the install script links both names at the same
 * binary, so the invoked name is the whole difference. In a Bun-compiled
 * binary `process.argv` is `['bun', '/$bunfs/root/<exe>', …]` — the embedded
 * script, never the symlink — while `process.argv0` is what the shell typed
 * (`kortixt`, or a path ending in it). Measured on bun 1.3.14.
 */
export function argvForInvocation(argv0: string, argv: string[]): string[] {
  return basename(argv0) === 'kortixt' ? ['t', ...argv] : argv;
}
