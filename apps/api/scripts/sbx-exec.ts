/** Ad-hoc: run a shell command in a Daytona sandbox by id (boot debugging).
 *   cd apps/api && KORTIX_URL=<tunnel> \
 *     bun --env-file=.env run scripts/sbx-exec.ts <sandboxId> '<command>'
 */
import { getDaytona } from '../src/shared/daytona';

const [, , id, ...rest] = process.argv;
const cmd = rest.join(' ');
if (!id || !cmd) {
  console.error('usage: sbx-exec.ts <sandboxId> <command>');
  process.exit(1);
}
const sandbox = await getDaytona().get(id);
const res = await sandbox.process
  .executeCommand(cmd, '/', undefined, 90)
  .catch((e: any) => ({ result: `EXEC ERROR: ${e?.message}`, exitCode: -1 }) as any);
console.log((res as any).result ?? '');
process.exit(0);
