import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { repositoryRoot, runFileGenerator } from './docs-generated-region.mjs';

const manifestPath = resolve(repositoryRoot, 'tests/spec/routes.generated.json');
const outputPath = resolve(
  repositoryRoot,
  'apps/web/src/components/iam/audit-http-routes.generated.ts',
);

async function renderAuditHttpRoutes() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const routes = manifest.routes.map(({ method, path }) => `${method} ${path}`);
  const uniqueRoutes = [...new Set(routes)];
  const routeKeys = manifest.routes.map(
    ({ method, path }) => `${method}|${path.split('/').filter(Boolean).join('|')}`,
  );

  if (uniqueRoutes.length !== manifest.count) {
    throw new Error(
      `Route manifest contains ${manifest.count} routes but ${uniqueRoutes.length} unique routes`,
    );
  }

  const output =
    `// Generated from tests/spec/routes.generated.json. Do not edit directly.\n` +
    `// Run: node apps/web/scripts/generate-audit-http-routes.mjs\n\n` +
    `const AUDIT_HTTP_ROUTE_KEYS = ${JSON.stringify(routeKeys, null, 2)} as const;\n\n` +
    `export const AUDIT_HTTP_ROUTES = AUDIT_HTTP_ROUTE_KEYS.map((key) => {\n` +
    `  const [method, ...segments] = key.split('|');\n` +
    `  return \`${"${method} /${segments.join('/')}"}\`;\n` +
    `});\n`;

  return format(output, { filepath: outputPath });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFileGenerator(
    'the audit HTTP routes',
    'node apps/web/scripts/generate-audit-http-routes.mjs',
    renderAuditHttpRoutes,
    outputPath,
  );
}
