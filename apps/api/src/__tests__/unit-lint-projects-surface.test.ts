/**
 * kortix-api/projects-surface (eslint.config.mjs): a module outside projects/
 * imports only projects/index.ts or projects/surface.ts. Runs the real config
 * on virtual files, so it also proves the rule is enabled.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ESLint } from 'eslint';

const API = join(import.meta.dir, '../..');
const eslint = new ESLint({ cwd: API });

async function deepImports(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(API, 'src', file) });
  return result.messages.filter((m) => m.ruleId === 'kortix-api/projects-surface').length;
}

describe('kortix-api/projects-surface', () => {
  test('flags a deep import into projects/ from outside it', async () => {
    expect(await deepImports('connectors/probe.ts', "import { x } from '../projects/lib/git';")).toBe(1);
    expect(await deepImports('connectors/probe.ts', "export { x } from '../projects/session-open';")).toBe(1);
    expect(await deepImports('connectors/probe.ts', "await import('../projects/routes/shared');")).toBe(1);
  });

  test('allows the index and the surface', async () => {
    expect(await deepImports('connectors/probe.ts', "import { x } from '../projects';")).toBe(0);
    expect(await deepImports('connectors/probe.ts', "import { x } from '../projects/index';")).toBe(0);
    expect(await deepImports('connectors/probe.ts', "import { x } from '../projects/surface';")).toBe(0);
  });

  test('allows projects/ to import its own files', async () => {
    expect(await deepImports('projects/probe.ts', "import { x } from './lib/git';")).toBe(0);
  });
});
