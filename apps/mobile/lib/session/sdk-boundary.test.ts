import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The session runtime is `@kortix/sdk`'s. This guard fails when non-test
 * source brings back the deleted `lib/opencode` module, a hand-built runtime
 * route, or an OpenCode-named symbol of the SDK.
 */

const APP_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['api', 'app', 'components', 'contexts', 'hooks', 'lib', 'stores'];

const BANNED_TEXT: Array<[label: string, pattern: RegExp]> = [
  ['lib/opencode', /lib\/opencode/],
  ['prompt_async', /prompt_async/],
  ['/global/event', /\/global\/event/],
];
const SDK_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"](@kortix\/sdk[^'"]*)['"]/g;
const OPENCODE_NAME = /open_?code/i;

/** What `source` breaks, one label per finding. */
function findings(source: string): string[] {
  const found = BANNED_TEXT.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  for (const [, names, specifier] of source.matchAll(SDK_IMPORT)) {
    if (OPENCODE_NAME.test(specifier)) found.push(specifier);
    for (const name of names.split(/[\s,{}]+/)) {
      if (OPENCODE_NAME.test(name)) found.push(`${name} from ${specifier}`);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('the session runtime is the SDK', () => {
  test('the matcher flags every banned form', () => {
    expect(findings(`import { x } from '@/lib/opencode/sync-store';`)).toEqual(['lib/opencode']);
    expect(findings('fetch(`${url}/session/${id}/prompt_async`)')).toEqual(['prompt_async']);
    expect(findings('new EventSource(`${url}/global/event`)')).toEqual(['/global/event']);
    expect(findings(`import { useOpenCodeSessions } from '@kortix/sdk/react';`)).toEqual([
      'useOpenCodeSessions from @kortix/sdk/react',
    ]);
    expect(
      findings(`import type {\n  Session,\n  OpencodeClient as Client,\n} from "@kortix/sdk";`)
    ).toEqual(['OpencodeClient from @kortix/sdk']);
    expect(findings(`export { opencode_thing } from '@kortix/sdk/opencode';`)).toEqual([
      '@kortix/sdk/opencode',
      'opencode_thing from @kortix/sdk/opencode',
    ]);
  });

  test('the matcher passes the neutral forms', () => {
    expect(findings(`import { useRuntimeSessions } from '@kortix/sdk/react';`)).toEqual([]);
    expect(findings(`import { openCode } from './local';\nimport { useSession } from '@kortix/sdk/react';`)).toEqual([]);
    expect(findings(`const id = ps.runtime_session_id ?? ps.opencode_session_id;`)).toEqual([]);
  });

  test('no non-test source file breaks the boundary', () => {
    const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));
    expect(files.length).toBeGreaterThan(500);
    const broken = files.flatMap((path) =>
      findings(readFileSync(path, 'utf8')).map((finding) => `${relative(APP_ROOT, path)}: ${finding}`)
    );
    expect(broken).toEqual([]);
  });
});
