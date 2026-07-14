/**
 * Upload a customer's extracted /workspace archive to the private backup bucket
 * and mint a time-limited signed download URL to hand back to them.
 *
 *   dotenvx run -f .env.prod --quiet -- \
 *   bun run src/scripts/deliver-suna-files.ts --account-id <uuid> --file <path> [--days 7]
 */
import { readFileSync, statSync } from 'node:fs';
import { config } from '../config';
import { getSupabase } from '../shared/supabase';
import { ensureBackupBucket } from '../projects/legacy-migration-storage';

function arg(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 ? Bun.argv[i + 1] : Bun.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const accountId = arg('--account-id');
const file = arg('--file');
const days = Number(arg('--days') ?? 7);
if (!accountId || !file) { console.error('--account-id and --file required'); process.exit(2); }

async function main() {
  const buf = readFileSync(file!);
  console.log(`uploading ${file} (${(statSync(file!).size / 1048576).toFixed(1)}MB) …`);
  await ensureBackupBucket();
  const bucket = config.LEGACY_MIGRATION_BACKUP_BUCKET;
  const path = `delivery/${accountId}/suna-files.tar.gz`;
  const supabase = getSupabase();

  const up = await supabase.storage.from(bucket).upload(path, buf, { upsert: true, contentType: 'application/gzip' });
  if (up.error) throw up.error;

  const expiresIn = days * 24 * 3600;
  const signed = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn, { download: 'suna-files.tar.gz' });
  if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error('failed to sign url');

  console.log(`\n✓ uploaded to ${bucket}/${path}`);
  console.log(`\nDownload link (valid ${days} days):\n${signed.data.signedUrl}\n`);
}

await main();
process.exit(0);
