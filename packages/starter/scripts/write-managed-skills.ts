/**
 * Materialize the always-latest managed Kortix skills — `kortix-cli` (the front
 * door) plus the managed `kortix-*` family — into a target directory as
 * `<skill>/…` folders. The sandbox image bakes this to `/opt/kortix/managed-skills`
 * and the agent server overlays it into every session at boot (see
 * `apps/kortix-sandbox-agent-server/src/injected-skills.ts`), so no project ever
 * goes stale on Kortix internals.
 *
 *   bun run scripts/write-managed-skills.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getManagedSkillFiles, getStarterFiles, isKortixManagedSkillName } from '../src/index';

const outDir = process.argv[2] ?? join(import.meta.dir, '..', 'dist', 'managed-skills');

const SKILLS_PREFIX = '.kortix/opencode/skills/';

function skillNameOf(path: string): string | null {
  if (!path.startsWith(SKILLS_PREFIX)) return null;
  return path.slice(SKILLS_PREFIX.length).split('/')[0] || null;
}

// `templates/managed/` holds the family itself; `templates/base/` still carries
// `kortix-cli` (the one managed skill deliberately left in the scaffold). Both
// roots feed the bake, so the injected set stays complete no matter which root a
// skill lives in — the failure mode that silently stranded `kortix-computer`
// under `templates/marketplace/` for its entire life.
const files = [
  ...getManagedSkillFiles(),
  ...getStarterFiles({ projectName: 'Kortix', template: 'general-knowledge-worker' }),
];
const skills = new Set<string>();
let count = 0;
for (const f of files) {
  const name = skillNameOf(f.path);
  if (!name) continue;
  if (!isKortixManagedSkillName(name)) continue; // the managed kortix-* family (incl. kortix-cli)
  const dest = join(outDir, f.path.slice(SKILLS_PREFIX.length)); // <name>/<...>
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.content);
  count += 1;
  skills.add(name);
}

console.log(
  `[managed-skills] wrote ${count} files for ${skills.size} skills to ${outDir}: ${[...skills].sort().join(', ')}`,
);
