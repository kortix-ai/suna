/**
 * Snapshot the Kortix tool modules into `src/kortix-tools.generated.json`, so
 * `kortix tools eject <name>` writes the same bytes the sandbox daemon runs.
 *
 * The source of truth is the daemon's folder
 * (apps/kortix-sandbox-agent-server/src/services/tools/kortix/<name>.ts). A
 * static JSON import is inlined into the compiled binary, which a read from
 * another app's tree at runtime is not. The snapshot is committed:
 * `scripts/build.sh` does not regenerate it, because the API image builds the
 * CLI from `apps/cli` and `packages/` only. `kortix-tools-embedded.test.ts`
 * fails when the committed copy differs from the daemon source.
 *
 * Regenerate after a change to a Kortix tool:
 * `bun run apps/cli/scripts/generate-kortix-tools.ts`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KORTIX_TOOLS_SOURCE_DIR = join(import.meta.dir, '../../kortix-sandbox-agent-server/src/services/tools/kortix');
export const KORTIX_TOOLS_SNAPSHOT = join(import.meta.dir, '../src/kortix-tools.generated.json');

/** Tool name → module source, in name order. */
export function buildKortixToolsSnapshot(): Record<string, string> {
  const files = readdirSync(KORTIX_TOOLS_SOURCE_DIR).filter((file) => file.endsWith('.ts')).sort();
  return Object.fromEntries(files.map((file) => [file.slice(0, -'.ts'.length), readFileSync(join(KORTIX_TOOLS_SOURCE_DIR, file), 'utf8')]));
}

if (import.meta.main) {
  writeFileSync(KORTIX_TOOLS_SNAPSHOT, `${JSON.stringify(buildKortixToolsSnapshot(), null, 2)}\n`);
  console.log(`Wrote ${KORTIX_TOOLS_SNAPSHOT}`);
}
