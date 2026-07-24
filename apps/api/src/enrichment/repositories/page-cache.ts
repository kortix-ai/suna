/**
 * Per-URL markdown cache.
 *
 * Two jobs, one table. It saves re-fetching pages that have not changed when a
 * domain is enriched again, and it is where the raw crawl survives when
 * extraction fails — so a failed job can be re-run later against the same
 * captured text instead of hitting the site a second time.
 *
 * Keyed by a hash of the canonical URL rather than the URL itself, so the
 * primary key stays a fixed width regardless of query-string length.
 */
import { enrichmentPageCache } from '@kortix/db';
import { inArray, lt } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../shared/db';

export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export async function getCachedPages(urls: string[]): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const hashes = urls.map(urlHash);
  const rows = await db
    .select({ url: enrichmentPageCache.url, markdown: enrichmentPageCache.markdown })
    .from(enrichmentPageCache)
    .where(inArray(enrichmentPageCache.urlHash, hashes));
  return new Map(rows.map((row) => [row.url, row.markdown]));
}

export async function putCachedPage(url: string, markdown: string): Promise<void> {
  await db
    .insert(enrichmentPageCache)
    .values({ urlHash: urlHash(url), url, markdown, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: enrichmentPageCache.urlHash,
      set: { url, markdown, fetchedAt: new Date() },
    });
}

/** Housekeeping for entries no re-enrichment would reuse. */
export async function prunePageCache(olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(enrichmentPageCache)
    .where(lt(enrichmentPageCache.fetchedAt, olderThan))
    .returning({ urlHash: enrichmentPageCache.urlHash });
  return deleted.length;
}
