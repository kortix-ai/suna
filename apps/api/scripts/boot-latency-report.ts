#!/usr/bin/env bun
/**
 * Fleet-wide session-boot latency report, read entirely from persisted telemetry.
 *
 * The companion to `bench-boot-attribution.ts`. That one BOOTS sessions, so it
 * measures whatever handful of boots you paid for — which is exactly how the
 * earlier round of this work reached a wrong conclusion: an 8-boot sample happened
 * to miss the warm image on every single boot, making the git clone look like a
 * universal ~7s cost when ~66% of real Daytona sessions skip it entirely.
 *
 * This script boots nothing. It aggregates what production already recorded:
 *   - kind='provision'  → HOST marks (row+tokens, image-cached, provider-create, …)
 *                         written by platform/services/provider-events.ts
 *   - kind='boot'       → IN-GUEST marks (repo-materialized, opencode-*, …)
 *                         relayed by the daemon at runtime-ready and written by
 *                         platform/services/boot-timeline-store.ts
 *
 * Both live in kortix.provider_events, so one query gives the real distribution
 * per provider per stage. Use this — not a small live sample — for any claim about
 * "boot takes N seconds".
 *
 * Usage:
 *   cd apps/api
 *   BOOT_DB_URL="$(dotenvx get DATABASE_URL -f .env.prod)" bun run scripts/boot-latency-report.ts
 *
 * Env:
 *   BOOT_DB_URL   Postgres URL. Required. READ-ONLY: this script only SELECTs.
 *   BOOT_DAYS     Lookback window in days (default 14).
 *   BOOT_JSON     "1" to emit JSON on stdout instead of the table.
 */
import { SQL } from 'bun';
import {
  aggregateTelemetryImages,
  type TelemetryImageRefRow,
} from './boot-image-kind';

const DB_URL = process.env.BOOT_DB_URL ?? '';
const DAYS = Number(process.env.BOOT_DAYS ?? 14);
const AS_JSON = process.env.BOOT_JSON === '1';

if (!DB_URL) {
  console.error('Need BOOT_DB_URL (e.g. BOOT_DB_URL="$(dotenvx get DATABASE_URL -f .env.prod)").');
  process.exit(1);
}

const sql = new SQL(DB_URL);

interface StageRow {
  provider: string;
  kind: string;
  label: string;
  n: number;
  p50: number;
  p90: number;
  p95: number;
  mx: number;
}

interface TotalRow {
  provider: string;
  kind: string;
  n: number;
  p50: number;
  p90: number;
  p95: number;
}

async function main() {
  // Per-stage costs. `deltaMs` exists on host marks (ProvisionTimeline computes
  // it); guest marks carry only cumulative `atMs`, so difference them in SQL via
  // lag() over the array order to get a per-stage cost for both shapes.
  const stages = (await sql`
    with unnested as (
      select
        e.provider::text as provider,
        e.kind,
        e.id,
        m.ord,
        m.mk->>'label' as label,
        (m.mk->>'atMs')::int as at_ms,
        (m.mk->>'deltaMs')::int as delta_ms
      from kortix.provider_events e,
        lateral jsonb_array_elements(e.marks) with ordinality m(mk, ord)
      where e.kind in ('provision', 'boot')
        and e.outcome = 'ok'
        and e.created_at > now() - (${DAYS} || ' days')::interval
    ),
    costed as (
      select
        provider,
        kind,
        regexp_replace(label, '[0-9]+x', 'Nx') as label,
        coalesce(
          delta_ms,
          at_ms - lag(at_ms, 1, 0) over (partition by id order by ord)
        ) as cost_ms
      from unnested
    )
    select provider, kind, label, count(*)::int as n,
      percentile_disc(0.5) within group (order by cost_ms)::int as p50,
      percentile_disc(0.9) within group (order by cost_ms)::int as p90,
      percentile_disc(0.95) within group (order by cost_ms)::int as p95,
      max(cost_ms)::int as mx
    from costed
    group by provider, kind, label
    order by provider, kind, p50 desc
  `) as StageRow[];

  const totals = (await sql`
    select provider::text as provider, kind, count(*)::int as n,
      percentile_disc(0.5) within group (order by total_ms)::int as p50,
      percentile_disc(0.9) within group (order by total_ms)::int as p90,
      percentile_disc(0.95) within group (order by total_ms)::int as p95
    from kortix.provider_events
    where kind in ('provision', 'boot') and outcome = 'ok'
      and total_ms is not null
      and created_at > now() - (${DAYS} || ' days')::interval
    group by provider, kind
    order by provider, kind
  `) as TotalRow[];

  // Warm-image hit rate. This is the number that makes or breaks any statement
  // about the clone: a warm hit means the repo was baked in and there was no
  // clone at all.
  const imageRefs = (await sql`
    select provider::text as provider,
      metadata->'runtimeArtifact'->>'providerArtifactRef' as image_ref,
      count(*)::int as n
    from kortix.session_sandboxes
    where created_at > now() - (${DAYS} || ' days')::interval
    group by 1, 2
  `) as TelemetryImageRefRow[];
  const images = aggregateTelemetryImages(imageRefs);

  if (AS_JSON) {
    console.log(JSON.stringify({ days: DAYS, totals, stages, images }, null, 1));
    await sql.close();
    return;
  }

  const KIND_LABEL: Record<string, string> = {
    provision: 'HOST (api → VM running)',
    boot: 'IN-GUEST (daemon start → runtime ready)',
  };

  console.log(`\nsession-boot latency — last ${DAYS} days, from persisted telemetry\n`);

  for (const kind of ['provision', 'boot']) {
    const t = totals.filter((r) => r.kind === kind);
    if (!t.length) {
      console.log(`── ${KIND_LABEL[kind]} — NO DATA`);
      if (kind === 'boot') {
        console.log('   (the daemon relays this at runtime-ready; a release carrying');
        console.log('    boot-timeline-relay.ts has to be deployed before rows appear)\n');
      }
      continue;
    }
    console.log(`── ${KIND_LABEL[kind]}`);
    for (const r of t) {
      console.log(`   ${r.provider.padEnd(10)} n=${String(r.n).padStart(6)}  p50=${String(r.p50).padStart(7)}ms  p90=${String(r.p90).padStart(7)}ms  p95=${String(r.p95).padStart(7)}ms`);
    }
    for (const prov of [...new Set(t.map((r) => r.provider))]) {
      const rows = stages.filter((s) => s.kind === kind && s.provider === prov);
      if (!rows.length) continue;
      console.log(`   ${prov} stages:`);
      for (const s of rows) {
        console.log(`     ${s.label.padEnd(28)} n=${String(s.n).padStart(6)} p50=${String(s.p50).padStart(7)}ms p90=${String(s.p90).padStart(7)}ms max=${String(s.mx).padStart(8)}ms`);
      }
    }
    console.log('');
  }

  console.log('── image kind at session start (warm-hit = no clone at all)');
  for (const r of images) {
    console.log(`   ${r.provider.padEnd(10)} ${r.image_kind.padEnd(26)} ${String(r.n).padStart(6)}`);
  }
  const byProv = new Map<string, { hit: number; total: number }>();
  for (const r of images) {
    const cur = byProv.get(r.provider) ?? { hit: 0, total: 0 };
    cur.total += r.n;
    if (r.image_kind === 'warm-hit') cur.hit += r.n;
    byProv.set(r.provider, cur);
  }
  console.log('');
  for (const [prov, v] of byProv) {
    const pct = v.total ? Math.round((v.hit / v.total) * 100) : 0;
    console.log(`   ${prov.padEnd(10)} warm-hit rate ${pct}%  (${v.hit}/${v.total})`);
  }
  console.log('');

  await sql.close();
}

main().catch(async (err) => {
  console.error(err);
  await sql.close().catch(() => {});
  process.exit(1);
});
