/**
 * Render Better Auth's managed tables for every enabled plugin into
 * `convex/functions/schema.ts` using kitcn's ORM schema renderer.
 *
 * kitcn's own `kitcn add auth --schema` refuses to run outside a Next/Expo/
 * Start/Vite app, so this script calls the same renderer directly. Re-run after
 * any plugin or Better Auth version change:
 *
 *   pnpm --filter kortix-convex gen:auth-schema
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { getAuthTables } from 'better-auth/db';

process.env.SITE_URL ??= 'http://localhost:3000';
process.env.KORTIX_API_URL ??= 'http://localhost:8008';
process.env.DEPLOY_ENV ??= 'local';

const require = createRequire(import.meta.url);
const kitcnRoot = path.dirname(require.resolve('kitcn/package.json'));
const chunk = (await import('node:fs')).readdirSync(path.join(kitcnRoot, 'dist')).find((f) => /^create-schema-orm-.*\.js$/.test(f));
if (!chunk) throw new Error('kitcn create-schema-orm chunk not found');
const { createSchemaOrm } = await import(path.join(kitcnRoot, 'dist', chunk));

const authModule = await import('../convex/functions/auth.ts');
const definition = authModule.default as unknown;
const resolveOptions = (def: unknown): Record<string, unknown> => {
  if (typeof def === 'function') return resolveOptions((def as (ctx: unknown) => unknown)({}));
  if (def && typeof def === 'object') {
    const { triggers: _t, ...rest } = def as Record<string, unknown>;
    return rest;
  }
  throw new Error(`unexpected auth definition: ${typeof def}`);
};
const options = resolveOptions(definition);
const tables = getAuthTables(options as never);
const file = path.resolve(import.meta.dirname, '../convex/functions/schema.ts');
const result = await createSchemaOrm({
  file,
  regenerateCommand: 'pnpm --filter kortix-convex gen:auth-schema',
  tables,
});
const code = (result as { code?: string } | undefined)?.code;
if (typeof code !== "string") throw new Error("createSchemaOrm returned no code");
(await import("node:fs")).writeFileSync(file, code);
console.log(`rendered ${Object.keys(tables).length} Better Auth tables -> ${path.relative(process.cwd(), file)}`);
