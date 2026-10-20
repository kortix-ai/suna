import { existsSync } from 'node:fs';
import { join } from 'node:path';

const UI_SRC = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'ui', 'src');

/**
 * The absolute path of a `packages/ui/src/<path>` file, for apps/web tests that
 * read the source of a component apps/web renders from `@kortix/ui`.
 */
export function uiSourcePath(path: string): string {
  const file = join(UI_SRC, path);
  if (!existsSync(file)) throw new Error(`packages/ui/src/${path} does not exist`);
  return file;
}
