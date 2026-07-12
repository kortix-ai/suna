/**
 * Preview what a template installs — resolve it from the catalog, render the
 * given inputs, and print the requirement set, the files it would commit, and
 * the merged kortix.yaml. An authoring aid; runs no git, touches no project.
 *
 *   bun run scripts/preview-template.ts ar-chaser alert_channel='#finance-alerts'
 *   bun run scripts/preview-template.ts ar-chaser cadence='0 0 8 * * 1-5' alert_channel='#collections'
 */

import { findCatalogEntryByName } from '../src/marketplace/catalog';
import { buildInstall } from '../src/marketplace/install-service';
import { buildTemplateInstall, parseTemplateBlock } from '../src/projects/templates/apply-template';

const [, , id, ...rest] = process.argv;
if (!id) {
  console.error('usage: bun run scripts/preview-template.ts <template-id> [key=value ...]');
  process.exit(1);
}

const inputs = Object.fromEntries(
  rest.map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
  }),
);

const entry = await findCatalogEntryByName(id);
if (!entry) {
  console.error(`Template "${id}" not found in the catalog.`);
  process.exit(1);
}
if (entry.item.type !== 'registry:template') {
  console.error(`"${id}" is a ${entry.item.type}, not a registry:template.`);
  process.exit(1);
}

const built = await buildInstall({
  id,
  configDir: '.kortix/opencode',
  existingLockRaw: null,
  legacyLockRaw: null,
  now: new Date().toISOString(),
});

const result = buildTemplateInstall({
  template: entry.item,
  block: parseTemplateBlock(entry.item),
  registryFiles: built.files,
  capabilities: built.capabilities,
  inputs,
  context: { projectName: 'Preview' },
  manifestRaw: null,
  manifestPath: 'kortix.yaml',
  existingConnectors: [],
  existingSecretKeys: [],
});

console.log(`\n▸ ${entry.item.title} (${entry.item.name})\n`);
console.log('Requirements:');
for (const r of result.requirements) {
  const extra = r.provider ? ` (${r.provider})` : '';
  console.log(`  [${r.status.padEnd(8)}] ${r.kind.padEnd(9)} ${r.label}${extra}`);
}
console.log('\nFiles it would commit:');
for (const f of result.files) console.log(`  ${f.path}`);
console.log('\nMerged kortix.yaml:\n');
console.log(result.files.find((f) => f.path === 'kortix.yaml')?.content ?? '(none)');
