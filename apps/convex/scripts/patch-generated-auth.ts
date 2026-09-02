/**
 * kitcn 0.32.1 codegen omits `incrementOne` from `convex/functions/generated/auth.ts`,
 * but its Convex adapter calls `generated/auth:incrementOne` (organization/create
 * fails with "Couldn't resolve api.generated.auth.incrementOne"). Re-export it from
 * the runtime after every codegen until upstream ships the export.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, '../convex/functions/generated/auth.ts');
const src = readFileSync(file, 'utf8');
if (/\bincrementOne\b/.test(src)) {
  console.log('generated/auth.ts already exports incrementOne');
} else {
  writeFileSync(
    file,
    `${src.trimEnd()}\n\n// kitcn 0.32.1 workaround (see scripts/patch-generated-auth.ts)\nexport const { incrementOne } = authRuntime;\n`,
  );
  console.log('patched generated/auth.ts: exported incrementOne');
}
