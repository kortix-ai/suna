import { readFileSync } from 'node:fs';

export function loadFileSet(path: string): Set<string> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { files: string[] };
    return new Set(data.files);
  } catch {
    return new Set();
  }
}
