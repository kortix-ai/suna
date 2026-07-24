/**
 * Integration test (real local DB): the enrichment worker drives a job from
 * queued to succeeded through every stage, against real `enrichment_*` tables.
 *
 * What is real here: the queue table, the lease claim, the profile cache, the
 * page cache, and the ordering between them. What is faked: the network (a
 * fixture site plus Jina Reader), the LLM gateway, and the git commit — the
 * three things a test must not actually do. That split is the point: the parts
 * that broke in earlier stages of this feature were the database interactions,
 * not the HTTP calls.
 *
 * Skips itself when the local Postgres has no project to attach to, so it
 * degrades to a no-op rather than a false failure on a bare checkout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { claimDueJobs, completeJob, enqueueJob } from '../enrichment/repositories/jobs';
import { getProfile } from '../enrichment/repositories/profiles';
import type { BoundedResponse } from '../enrichment/services/safe-fetch';
import { runEnrichmentJob, type EnrichmentJobDeps } from '../enrichment/services/worker';

const memoryWrites: Array<{ path: string; content: string }> = [];
let extractionResponse = '';
let gatewayCalls = 0;

const DOMAIN = 'integration-example.com';
const ORIGIN = `https://${DOMAIN}`;

const VALID_PROFILE = JSON.stringify({
  name: 'Integration Example Inc',
  tagline: 'Testing end to end',
  description: 'A company used by the enrichment integration test.',
  products: [{ name: 'Widget', description: 'A widget', url: `${ORIGIN}/product` }],
  team: [{ name: 'Ada Lovelace', role: 'CEO', link: null }],
  socials: [],
  pricingSummary: 'Free and paid tiers.',
  blogPosts: [],
  contact: { email: null, phone: null, address: null },
  sectionSources: [{ section: 'team', urls: [`${ORIGIN}/team`] }],
  sources: [`${ORIGIN}/`, `${ORIGIN}/about`],
});

function page(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

const SITE: Record<string, () => Response> = {
  [`${ORIGIN}/robots.txt`]: () =>
    new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } }),
  [`${ORIGIN}/sitemap.xml`]: () =>
    new Response(
      `<urlset><url><loc>${ORIGIN}/about</loc></url><url><loc>${ORIGIN}/team</loc></url></urlset>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    ),
  [`${ORIGIN}/`]: () =>
    page(
      `<html><head><title>Integration Example Inc</title>
       <script type="application/ld+json">{"@type":"Organization","name":"Integration Example Inc"}</script>
       </head><body><a href="/about">About</a></body></html>`,
    ),
  [`${ORIGIN}/about`]: () => page('<html><body><h1>About us</h1></body></html>'),
  [`${ORIGIN}/team`]: () => page('<html><body><h1>Team</h1></body></html>'),
};

let fetchLog: string[] = [];

async function toBounded(url: string, res: Response): Promise<BoundedResponse> {
  return {
    url,
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
    truncated: false,
  };
}

/**
 * The network, the model and git, supplied directly. Nothing is mock.module'd:
 * that is process-wide here and would collide with the unit tests that
 * exercise the egress guard and the gateway for real.
 */
function testDeps(): Partial<EnrichmentJobDeps> {
  return {
    assertUrl: (async (url: string) => new URL(url)) as never,
    fetchImpl: (async (url: string) => {
      fetchLog.push(url);
      if (url.startsWith('https://r.jina.ai/')) {
        const target = url.slice('https://r.jina.ai/'.length);
        return toBounded(
          url,
          new Response(`# Page\n\nMarkdown for ${target}`, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        );
      }
      const handler = SITE[url];
      return toBounded(url, handler ? handler() : new Response('not found', { status: 404 }));
    }) as never,
    runChat: (async (_principal: unknown, fn: (chat: unknown) => Promise<unknown>) =>
      fn(async () => {
        gatewayCalls += 1;
        return extractionResponse;
      })) as never,
    memoryPortFor: async () => ({
      read: async (path: string) =>
        memoryWrites.filter((w) => w.path === path).at(-1)?.content ?? null,
      commit: async (path: string, content: string) => {
        memoryWrites.push({ path, content });
      },
    }),
  };
}

let ctx: { projectId: string; accountId: string } | null = null;
const jobIds: string[] = [];

async function seedJob(force = false) {
  const { job } = await enqueueJob({
    accountId: ctx!.accountId,
    projectId: ctx!.projectId,
    createdBy: null,
    domain: DOMAIN,
    idempotencyKey: `${ctx!.projectId}:${DOMAIN}`,
    force,
  });
  jobIds.push(job.jobId);
  return job;
}

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (rows[0]) ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };
});

afterAll(async () => {
  for (const id of jobIds) {
    await db.execute(sql`delete from kortix.enrichment_jobs where job_id = ${id}`);
  }
  await db.execute(sql`delete from kortix.enrichment_profiles where domain = ${DOMAIN}`);
  await db.execute(sql`delete from kortix.enrichment_page_cache where url like ${`${ORIGIN}%`}`);
});

beforeEach(async () => {
  fetchLog = [];
  gatewayCalls = 0;
  memoryWrites.length = 0;
  extractionResponse = VALID_PROFILE;
  await db.execute(sql`delete from kortix.enrichment_profiles where domain = ${DOMAIN}`);
  await db.execute(sql`delete from kortix.enrichment_page_cache where url like ${`${ORIGIN}%`}`);
  await db.execute(sql`delete from kortix.enrichment_jobs where domain = ${DOMAIN}`);
  jobIds.length = 0;
});

describe('enrichment worker (integration)', () => {
  test('runs a job from queued through to a stored profile and memory write', async () => {
    if (!ctx) return;
    const job = await seedJob();

    const [claimed] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    expect(claimed?.jobId).toBe(job.jobId);
    expect(claimed.status).toBe('running');

    const result = await runEnrichmentJob(claimed, testDeps());

    expect(result.domain).toBe(DOMAIN);
    expect(result.cacheHit).toBe(false);
    expect(result.pagesFetched).toBeGreaterThan(0);

    const stored = await getProfile(DOMAIN);
    expect(stored?.profile.name).toBe('Integration Example Inc');

    expect(memoryWrites.map((w) => w.path)).toEqual([
      `.kortix/memory/enrichment/${DOMAIN}.md`,
      '.kortix/memory/MEMORY.md',
    ]);
    expect(memoryWrites[0].content).toContain('Integration Example Inc');
    expect(memoryWrites[1].content).toContain(`enrichment/${DOMAIN}.md`);
  });

  test('marks the job succeeded with its result', async () => {
    if (!ctx) return;
    const job = await seedJob();
    const [claimed] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    const result = await runEnrichmentJob(claimed, testDeps());
    await completeJob(job.jobId, { ...result });

    const rows = (await db.execute(
      sql`select status, result from kortix.enrichment_jobs where job_id = ${job.jobId}`,
    )) as unknown as Array<{ status: string; result: Record<string, unknown> }>;

    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].result.domain).toBe(DOMAIN);
  });

  test('attaches a second submission to the in-flight job', async () => {
    if (!ctx) return;
    const first = await seedJob();
    const second = await enqueueJob({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      createdBy: null,
      domain: DOMAIN,
      idempotencyKey: `${ctx.projectId}:${DOMAIN}`,
      force: false,
    });

    expect(second.attached).toBe(true);
    expect(second.job.jobId).toBe(first.jobId);
  });

  test('a fresh cached profile skips crawling and extraction', async () => {
    if (!ctx) return;
    const first = await seedJob();
    const [claimedFirst] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    await runEnrichmentJob(claimedFirst, testDeps());
    await completeJob(first.jobId, {});

    fetchLog = [];
    gatewayCalls = 0;
    memoryWrites.length = 0;

    const second = await seedJob();
    const [claimedSecond] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    const result = await runEnrichmentJob(claimedSecond, testDeps());

    expect(result.cacheHit).toBe(true);
    expect(gatewayCalls).toBe(0);
    expect(fetchLog).toHaveLength(0);
    // The crawl is shared, but landing the profile in this project's memory
    // is not — it still has to happen.
    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(second.jobId).not.toBe(first.jobId);
  });

  test('force bypasses the cache', async () => {
    if (!ctx) return;
    const first = await seedJob();
    const [claimedFirst] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    await runEnrichmentJob(claimedFirst, testDeps());
    await completeJob(first.jobId, {});

    gatewayCalls = 0;
    await seedJob(true);
    const [claimedSecond] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    const result = await runEnrichmentJob(claimedSecond, testDeps());

    expect(result.cacheHit).toBe(false);
    expect(gatewayCalls).toBeGreaterThan(0);
  });

  test('caches fetched pages so a re-run does not re-fetch them', async () => {
    if (!ctx) return;
    const first = await seedJob();
    const [claimedFirst] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    await runEnrichmentJob(claimedFirst, testDeps());
    await completeJob(first.jobId, {});

    const cached = (await db.execute(
      sql`select count(*)::int as n from kortix.enrichment_page_cache where url like ${`${ORIGIN}%`}`,
    )) as unknown as Array<{ n: number }>;
    expect(cached[0].n).toBeGreaterThan(0);

    fetchLog = [];
    await seedJob(true);
    const [claimedSecond] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });
    await runEnrichmentJob(claimedSecond, testDeps());

    expect(fetchLog.some((u) => u.startsWith('https://r.jina.ai/'))).toBe(false);
  });

  test('stores no profile when extraction never validates', async () => {
    if (!ctx) return;
    extractionResponse = JSON.stringify({ name: 'No sources', sources: [] });
    await seedJob();
    const [claimed] = await claimDueJobs({ workerId: 'test', limit: 5, leaseMs: 60_000 });

    await expect(runEnrichmentJob(claimed, testDeps())).rejects.toThrow();

    expect(await getProfile(DOMAIN)).toBeNull();
    expect(memoryWrites).toHaveLength(0);
    // The raw crawl survives so the job can be re-run without re-fetching.
    const cached = (await db.execute(
      sql`select count(*)::int as n from kortix.enrichment_page_cache where url like ${`${ORIGIN}%`}`,
    )) as unknown as Array<{ n: number }>;
    expect(cached[0].n).toBeGreaterThan(0);
  });

  test('reclaims a job whose lease has expired', async () => {
    if (!ctx) return;
    const job = await seedJob();
    await claimDueJobs({ workerId: 'worker-a', limit: 5, leaseMs: 60_000 });

    await db.execute(
      sql`update kortix.enrichment_jobs set locked_until = now() - interval '1 minute' where job_id = ${job.jobId}`,
    );

    const reclaimed = await claimDueJobs({ workerId: 'worker-b', limit: 5, leaseMs: 60_000 });
    expect(reclaimed.map((r) => r.jobId)).toContain(job.jobId);
    expect(reclaimed[0].lockedBy).toBe('worker-b');
  });

  test('does not hand a leased job to a second worker', async () => {
    if (!ctx) return;
    await seedJob();
    const first = await claimDueJobs({ workerId: 'worker-a', limit: 5, leaseMs: 60_000 });
    const second = await claimDueJobs({ workerId: 'worker-b', limit: 5, leaseMs: 60_000 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
