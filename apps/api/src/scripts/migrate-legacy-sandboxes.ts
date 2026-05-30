import { runLegacySandboxMigration, type LegacyMigrationMode } from '../projects/legacy-migration';

function argValue(flag: string): string | undefined {
  const exactIndex = Bun.argv.indexOf(flag);
  if (exactIndex >= 0) return Bun.argv[exactIndex + 1];
  const prefixed = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function hasFlag(flag: string): boolean {
  return Bun.argv.includes(flag);
}

function printUsage(): never {
  console.error(`Usage:
  bun run src/scripts/migrate-legacy-sandboxes.ts --dry-run [--account-id UUID] [--sandbox-id UUID] [--limit N] [--repo-url-template URL]
  bun run src/scripts/migrate-legacy-sandboxes.ts --apply --repo-url-template 'https://github.com/org/{slug}.git' [--run-id ID]
  bun run src/scripts/migrate-legacy-sandboxes.ts --verify [--run-id ID] [--account-id UUID] [--sandbox-id UUID]
  bun run src/scripts/migrate-legacy-sandboxes.ts --rollback --run-id ID

Placeholders for --repo-url-template:
  {account_id} {sandbox_id} {session_id} {project_id} {slug}
`);
  process.exit(2);
}

function parseMode(): LegacyMigrationMode {
  const modes: Array<[string, LegacyMigrationMode]> = [
    ['--dry-run', 'dry_run'],
    ['--apply', 'apply'],
    ['--verify', 'verify'],
    ['--rollback', 'rollback'],
  ];
  const selected = modes.filter(([flag]) => hasFlag(flag));
  if (selected.length !== 1) printUsage();
  return selected[0]![1];
}

const mode = parseMode();
const limitValue = argValue('--limit');
const limit = limitValue ? Number(limitValue) : undefined;

if (limitValue && (!Number.isFinite(limit) || limit! <= 0)) {
  throw new Error('--limit must be a positive number');
}

if (mode === 'rollback' && !argValue('--run-id') && !argValue('--sandbox-id')) {
  throw new Error('--rollback requires --run-id or --sandbox-id');
}

const result = await runLegacySandboxMigration({
  mode,
  runId: argValue('--run-id'),
  accountId: argValue('--account-id'),
  sandboxId: argValue('--sandbox-id'),
  repoUrlTemplate: argValue('--repo-url-template'),
  limit,
});

console.log(JSON.stringify(result, null, 2));

process.exit(result.failed > 0 ? 1 : 0);
