import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The repository checkout this test tree lives in. */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** A repository file as UTF-8 text; `path` is relative to the repository root. */
export const readRepoFile = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/** A `.github/workflows/<name>` file as UTF-8 text. */
export const readWorkflow = (name: string) => readRepoFile(`.github/workflows/${name}`);
