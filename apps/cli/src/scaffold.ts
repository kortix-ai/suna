import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  buildStarterFiles,
  gitignoreFile,
  topLevelReadme,
  type StarterFile,
} from './starter.ts';

export interface ScaffoldInput {
  /** Absolute path of the destination directory. Must already exist. */
  repoRoot: string;
  /** Normalized project name written into kortix.toml and READMEs. */
  projectName: string;
}

/**
 * Write every file the CLI owns into `repoRoot`. The caller is expected
 * to have created the directory and made it a git repo. We overwrite
 * unconditionally — `kortix` is a "create" command, never a refresh.
 */
export function applyScaffold(input: ScaffoldInput): { filesWritten: string[] } {
  const files: StarterFile[] = [
    ...buildStarterFiles(input),
    topLevelReadme(input),
    gitignoreFile(),
  ];

  for (const file of files) {
    const abs = resolve(input.repoRoot, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, 'utf8');
  }

  return { filesWritten: files.map((f) => f.path) };
}
