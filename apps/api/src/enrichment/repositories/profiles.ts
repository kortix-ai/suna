/**
 * The cross-request profile cache.
 *
 * Keyed by domain and deliberately not scoped to a tenant: a company's public
 * website is the same page for everyone, so the first org to enrich a domain
 * spares every later one the crawl, the extraction cost and the wait. Freshness
 * is evaluated at read time against a configurable TTL rather than being baked
 * into the row, so changing the TTL takes effect immediately instead of only
 * for rows written afterwards.
 */
import { enrichmentProfiles } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { CompanyProfile, CrawlStatus } from '../schemas';

export type EnrichmentProfileRow = typeof enrichmentProfiles.$inferSelect;

export interface CachedProfile {
  domain: string;
  profile: CompanyProfile;
  crawlStatus: CrawlStatus;
  crawledAt: Date;
  model: string | null;
}

function toCached(row: EnrichmentProfileRow): CachedProfile {
  return {
    domain: row.domain,
    profile: row.profile as unknown as CompanyProfile,
    crawlStatus: (row.crawlStatus as CrawlStatus) ?? 'complete',
    crawledAt: row.crawledAt,
    model: row.model,
  };
}

export async function getProfile(domain: string): Promise<CachedProfile | null> {
  const [row] = await db
    .select()
    .from(enrichmentProfiles)
    .where(eq(enrichmentProfiles.domain, domain))
    .limit(1);
  return row ? toCached(row) : null;
}

/** A cached profile is usable when it is younger than the TTL. */
export async function getFreshProfile(
  domain: string,
  ttlDays: number,
  now: Date = new Date(),
): Promise<CachedProfile | null> {
  const cached = await getProfile(domain);
  if (!cached) return null;
  const ageMs = now.getTime() - cached.crawledAt.getTime();
  return ageMs <= ttlDays * 24 * 60 * 60 * 1000 ? cached : null;
}

export async function upsertProfile(input: {
  domain: string;
  profile: CompanyProfile;
  crawlStatus: CrawlStatus;
  model: string;
  crawledAt?: Date;
}): Promise<void> {
  const crawledAt = input.crawledAt ?? new Date();
  await db
    .insert(enrichmentProfiles)
    .values({
      domain: input.domain,
      profile: input.profile as unknown as Record<string, unknown>,
      crawlStatus: input.crawlStatus,
      model: input.model,
      crawledAt,
    })
    .onConflictDoUpdate({
      target: enrichmentProfiles.domain,
      set: {
        profile: input.profile as unknown as Record<string, unknown>,
        crawlStatus: input.crawlStatus,
        model: input.model,
        crawledAt,
      },
    });
}
