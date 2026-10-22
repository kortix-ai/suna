import { config } from '../config';
import { getSupabase } from '../shared/supabase';

/** @deprecated OpenCode only. OpenCode is sunset: no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
// Read-only since the Suna migration writer was deleted (R6.5): the archives it
// uploaded stay in the bucket and session open restores them
// (legacy-migration-rehydrate.ts).
export async function downloadOpencodeArchive(sandboxId: string): Promise<Buffer | null> {
  const { data, error } = await getSupabase()
    .storage.from(config.LEGACY_MIGRATION_BACKUP_BUCKET)
    .download(`${sandboxId}/opencode.tar.gz`);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
