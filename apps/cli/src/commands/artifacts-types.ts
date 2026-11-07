// `kortix artifacts types`: the types, their format and a starter.
import { listArtifactTypes } from '@kortix/sdk';
import { fail } from '../command-helpers.ts';
import { C, pad } from '../style.ts';
import { TYPES, type ArtifactsRun } from './artifacts-run.ts';

export async function artifactsTypes({ pid, f, a0, out }: ArtifactsRun): Promise<number> {
  const types = await listArtifactTypes(pid);
  if (a0) {
    const t = types.find((x) => x.type === a0);
    if (!t) return fail(`unknown type "${a0}". One of ${TYPES.join(', ')}.`);
    if (f.json) return out(t, '');
    if (f.starter) return out(null, t.starter);
    process.stdout.write(`${C.bold}${t.name}${C.reset} (${t.type}): ${t.description}\n\nFormat:\n${t.format.split('\n').map((l) => `  - ${l}`).join('\n')}\n\nStarter:\n\n${t.starter}`);
    return 0;
  }
  if (f.json) return out(types, '');
  for (const t of types) process.stdout.write(`${pad(t.type, 7)}${t.description}\n`);
  process.stdout.write(`\nRun \`kortix artifacts types <type>\` for its format and a starter.\n`);
  return 0;
}
