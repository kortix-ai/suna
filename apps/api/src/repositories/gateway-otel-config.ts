import { eq } from 'drizzle-orm';
import { gatewayOtelConfigs } from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import { parseHeaderString } from '../lib/otel';

/**
 * A project's OTLP trace-export destination — the "connect any tool" surface
 * (Observability tab). `headers` is already decrypted and parsed into a
 * key→value map (same shape OTEL_EXPORTER_OTLP_HEADERS uses).
 */
export interface ProjectOtelExporterConfig {
  enabled: boolean;
  endpoint: string | null;
  headers: Record<string, string>;
}

/** Display-safe view returned to the UI — never the decrypted header values. */
export interface ProjectOtelConfigSummary {
  enabled: boolean;
  endpoint: string | null;
  hasHeaders: boolean;
  updatedAt: string | null;
}

function serializeHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k, v]) => k.trim() && v.trim())
    .map(([k, v]) => `${k.trim()}=${v.trim()}`)
    .join(',');
}

async function loadFromDb(projectId: string): Promise<ProjectOtelExporterConfig | null> {
  const [row] = await db
    .select()
    .from(gatewayOtelConfigs)
    .where(eq(gatewayOtelConfigs.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    enabled: row.enabled,
    endpoint: row.endpoint,
    headers: row.headersEnc ? parseHeaderString(decryptProjectSecret(projectId, row.headersEnc)) : {},
  };
}

// ─── Hot-path cache ──────────────────────────────────────────────────────────
//
// emitGatewayGenAiSpan (llm-gateway/hooks.ts) fires on EVERY gateway call and
// is fire-and-forget/best-effort telemetry — it must never add a database
// round trip to the request path. `peekCachedProjectOtelExporter` is
// deliberately SYNCHRONOUS: it returns whatever is already cached (possibly
// `undefined` on a cold project) and, on a miss/stale entry, kicks a
// background refresh rather than awaiting it. The very first span after a
// project enables export (or right after a TTL expiry) may be skipped; every
// span after that within the TTL window is exported correctly. That tradeoff
// — occasional first-hit staleness for zero added latency on a hot,
// best-effort path — mirrors billing/services/entitlements.ts's account-tier
// cache.
const TTL_MS = 30_000;
const cache = new Map<string, { config: ProjectOtelExporterConfig | null; expiresAt: number }>();
const inFlight = new Set<string>();

function refresh(projectId: string): void {
  if (inFlight.has(projectId)) return;
  inFlight.add(projectId);
  void loadFromDb(projectId)
    .then((config) => cache.set(projectId, { config, expiresAt: Date.now() + TTL_MS }))
    .catch(() => {
      // Best-effort — leave the previous cache entry (if any) in place rather
      // than poisoning it with a transient DB error.
    })
    .finally(() => inFlight.delete(projectId));
}

export function peekCachedProjectOtelExporter(
  projectId: string,
): ProjectOtelExporterConfig | null | undefined {
  const hit = cache.get(projectId);
  const fresh = hit && hit.expiresAt > Date.now();
  if (!fresh) refresh(projectId);
  return hit?.config;
}

/** Force the next read to hit the DB — call after a config write so the
 *  change takes effect immediately instead of waiting out the TTL. */
export function invalidateProjectOtelExporterCache(projectId: string): void {
  cache.delete(projectId);
}

// ─── CRUD (Observability tab) ───────────────────────────────────────────────

export async function getProjectOtelConfigSummary(
  projectId: string,
): Promise<ProjectOtelConfigSummary> {
  const [row] = await db
    .select()
    .from(gatewayOtelConfigs)
    .where(eq(gatewayOtelConfigs.projectId, projectId))
    .limit(1);
  if (!row) return { enabled: false, endpoint: null, hasHeaders: false, updatedAt: null };
  return {
    enabled: row.enabled,
    endpoint: row.endpoint,
    hasHeaders: Boolean(row.headersEnc),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SetProjectOtelConfigInput {
  projectId: string;
  updatedBy: string;
  enabled: boolean;
  endpoint: string | null;
  /** Undefined = leave the stored headers untouched (e.g. toggling `enabled`
   *  without re-entering a token); null/{} = clear them. */
  headers?: Record<string, string> | null;
}

export async function setProjectOtelConfig(input: SetProjectOtelConfigInput): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select({ headersEnc: gatewayOtelConfigs.headersEnc })
    .from(gatewayOtelConfigs)
    .where(eq(gatewayOtelConfigs.projectId, input.projectId))
    .limit(1);

  const headersEnc =
    input.headers === undefined
      ? (existing?.headersEnc ?? null)
      : (() => {
          const serialized = serializeHeaders(input.headers ?? {});
          return serialized ? encryptProjectSecret(input.projectId, serialized) : null;
        })();

  await db
    .insert(gatewayOtelConfigs)
    .values({
      projectId: input.projectId,
      enabled: input.enabled,
      endpoint: input.endpoint,
      headersEnc,
      createdBy: input.updatedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gatewayOtelConfigs.projectId,
      set: {
        enabled: input.enabled,
        endpoint: input.endpoint,
        headersEnc,
        updatedAt: now,
      },
    });

  invalidateProjectOtelExporterCache(input.projectId);
}

export async function deleteProjectOtelConfig(projectId: string): Promise<void> {
  await db.delete(gatewayOtelConfigs).where(eq(gatewayOtelConfigs.projectId, projectId));
  invalidateProjectOtelExporterCache(projectId);
}
