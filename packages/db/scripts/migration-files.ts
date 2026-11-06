import { readdirSync } from 'node:fs';

/** A migration file is `<name>.sql` or `<name>.concurrent.ts`; a `.test.ts` beside them never is. */
export function isMigrationFile(filename: string): boolean {
  return filename.endsWith('.sql') || filename.endsWith('.concurrent.ts');
}

export function migrationNamesInDirectory(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter(isMigrationFile)
    .map((filename) => filename.replace(/\.(sql|ts)$/, ''))
    .sort();
}
