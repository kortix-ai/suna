/**
 * Connector materialization sweep — read `[[connectors]]` from kortix.toml,
 * fetch + normalize each connector's catalog, and upsert into the DB
 * (executor_connectors / _actions / _policies). Definitions live in git
 * (manifest = source of truth, like triggers); this populates the runtime view
 * the gateway + dashboard read. Catalog fetch is best-effort per connector:
 * a connector that can't be reached is stored with status='error' + 0 actions,
 * never failing the whole sweep. See docs/specs/executor.md §3, §7.
 */
import { and, eq } from 'drizzle-orm';
import { parse as parseToml } from 'smol-toml';
import {
  executorConnectorActions,
  executorConnectorPolicies,
  executorConnectors,
  executorProjectPolicies,
  executorProjectSettings,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { withProjectGitAuth } from '../projects/index';
import { readManifest } from '../projects/triggers';
import { readRepoFile, type GitBackedProject } from '../projects/git';
import { extractConnectors, manifestHashForConnector, type ConnectorSpec } from '../projects/connectors';
import { extractProjectPolicies } from '../projects/policies';
import {
  normalizeGraphql,
  normalizeHttp,
  normalizeMcp,
  normalizeOpenApi,
  normalizePipedream,
} from './normalize';
import type { NormalizedAction, HttpRouteSpec } from './types';
import { performMcpJsonRpc, type FetchImpl, type McpTransport } from './execute';
import { connectorConfig, toPolicyRows, toProjectPolicyRows } from './materialize';
import { pipedreamCatalog, pipedreamConfigured } from './pipedream';

export interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

export interface SyncOptions {
  /**
   * Re-fetch every connector's catalog even when its manifest hash is
   * unchanged. The manual "Sync" button passes this (the user is explicitly
   * asking to re-pull catalogs, e.g. an MCP server gained new tools). The
   * automatic reconcile paths (CRUD, CR-merge, periodic sweep) leave it off so
   * an unchanged connector skips its (network) catalog fetch.
   */
  force?: boolean;
}

interface ResolvedCatalog {
  actions: NormalizedAction[];
  /** OpenAPI server discovered from the doc (folded into config). */
  server: string | null;
  error?: string;
}

/**
 * Materialize a project's connectors from its manifest. Loads the project +
 * git auth (so private repos resolve), reads kortix.toml, then upserts.
 */
export async function syncProjectConnectors(projectId: string, accountId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { synced: 0, errors: [{ slug: '(project)', error: 'project not found' }] };

  const gitProject = await withProjectGitAuth(row);
  const manifest = await readManifest(gitProject).catch(() => null);
  if (!manifest) return { synced: 0, errors: [{ slug: '(manifest)', error: 'kortix.toml not found or unreadable' }] };

  const { specs, errors: parseErrors } = extractConnectors(manifest);
  const errors: SyncResult['errors'] = parseErrors.map((e) => ({ slug: e.slug, error: e.error }));

  // Project-level policies + settings — separate scope, always reconciled (cheap).
  const projectPoliciesParsed = extractProjectPolicies(manifest);
  for (const e of projectPoliciesParsed.errors) {
    errors.push({ slug: '(policies)', error: e.error });
  }
  await reconcileProjectPolicies(projectId, projectPoliciesParsed);

  const existing = await db
    .select({ slug: executorConnectors.slug, connectorId: executorConnectors.connectorId, manifestHash: executorConnectors.manifestHash, status: executorConnectors.status })
    .from(executorConnectors)
    .where(eq(executorConnectors.projectId, projectId));
  const existingBySlug = new Map(existing.map((e) => [e.slug, e]));
  const desiredSlugs = new Set(specs.map((s) => s.slug));

  let synced = 0;
  for (const spec of specs) {
    try {
      const ex = existingBySlug.get(spec.slug);
      // Cheap reconcile: when the connector's catalog-affecting fields are
      // unchanged (hash match) and it last materialized cleanly, skip the
      // network catalog fetch. The DB row's cheap fields (name/enabled/
      // policies) are still reconciled inside upsertConnector. `force` (manual
      // sync) always re-fetches; error rows always retry.
      const catalogUnchanged =
        !opts.force && !!ex && ex.status !== 'error' && ex.manifestHash === manifestHashForConnector(spec);
      const catalog = catalogUnchanged ? null : await resolveCatalog(gitProject, spec);
      await upsertConnector(projectId, accountId, spec, catalog, ex?.connectorId ?? null);
      if (catalog?.error) errors.push({ slug: spec.slug, error: catalog.error });
      synced++;
    } catch (e) {
      errors.push({ slug: spec.slug, error: (e as Error).message });
    }
  }

  // Delete connectors no longer in the manifest.
  for (const e of existing) {
    if (!desiredSlugs.has(e.slug)) {
      await db.delete(executorConnectors).where(eq(executorConnectors.connectorId, e.connectorId));
    }
  }

  return { synced, errors };
}

/**
 * Upsert one connector + reconcile its actions + policies.
 *
 * `catalog === null` means "catalog unchanged" (hash matched, no re-fetch): we
 * leave the stored config + actions untouched and only reconcile the cheap
 * fields (name / enabled / status / policies) so a manifest edit that just
 * toggled `enabled` or tweaked policies still lands without a network round-trip.
 */
async function upsertConnector(
  projectId: string,
  accountId: string,
  spec: ConnectorSpec,
  catalog: ResolvedCatalog | null,
  existingId: string | null,
): Promise<void> {
  const manifestHash = manifestHashForConnector(spec);
  const status = catalog?.error ? 'error' : spec.enabled ? 'active' : 'disabled';
  // Credentials live in executor_credentials now; authSecret is legacy (kept nullable).
  const authSecret = spec.auth.secret ?? null;
  const credentialMode = spec.credentialMode;

  // Cheap fields reconciled on every sync. `config` (which folds in the
  // discovered server) only changes when we actually re-resolved the catalog.
  const common = {
    name: spec.name,
    providerType: spec.provider,
    enabled: spec.enabled,
    authSecret,
    credentialMode,
    manifestHash,
    status,
    lastError: catalog?.error ?? null,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  } as const;

  let connectorId = existingId;
  if (connectorId) {
    await db
      .update(executorConnectors)
      .set(catalog ? { ...common, config: connectorConfig(spec, catalog.server) } : common)
      .where(eq(executorConnectors.connectorId, connectorId));
  } else {
    // A brand-new connector is never "unchanged", so catalog is always present
    // here; fall back to a server-less config defensively.
    const [created] = await db
      .insert(executorConnectors)
      .values({
        accountId,
        projectId,
        slug: spec.slug,
        ...common,
        config: connectorConfig(spec, catalog?.server ?? null),
      })
      .returning({ connectorId: executorConnectors.connectorId });
    connectorId = created!.connectorId;
  }

  // Actions only change when the catalog was re-resolved — leave them in place
  // on a cheap reconcile.
  if (catalog) {
    await db.delete(executorConnectorActions).where(eq(executorConnectorActions.connectorId, connectorId));
    if (catalog.actions.length > 0) {
      await db.insert(executorConnectorActions).values(
        catalog.actions.map((a) => ({
          connectorId: connectorId!,
          path: a.path,
          name: a.name,
          description: a.description,
          inputSchema: a.inputSchema,
          outputSchema: a.outputSchema,
          risk: a.risk,
          binding: a.binding as unknown as Record<string, unknown>,
        })),
      );
    }
  }

  // Policies gate calls (not part of the catalog hash) — always reconcile; cheap.
  await db.delete(executorConnectorPolicies).where(eq(executorConnectorPolicies.connectorId, connectorId));
  const policyRows = toPolicyRows(spec);
  if (policyRows.length > 0) {
    await db.insert(executorConnectorPolicies).values(
      policyRows.map((p) => ({ connectorId: connectorId!, match: p.match, action: p.action, position: p.position })),
    );
  }
}

/** Fetch + normalize a connector's catalog. Best-effort; never throws. */
export async function resolveCatalog(project: GitBackedProject, spec: ConnectorSpec): Promise<ResolvedCatalog> {
  try {
    switch (spec.provider) {
      case 'openapi': {
        const doc = await loadSpecDoc(project, spec.spec!);
        let server = Array.isArray(doc?.servers) && doc.servers[0]?.url ? String(doc.servers[0].url) : null;
        // Specs often use a relative server (e.g. Petstore's "/api/v3"); resolve
        // it against the spec URL's origin so the gateway has an absolute base.
        if (server && server.startsWith('/') && /^https?:\/\//i.test(spec.spec!)) {
          try { server = new URL(server, spec.spec!).href.replace(/\/$/, ''); } catch { /* keep */ }
        }
        return { actions: normalizeOpenApi(doc), server };
      }
      case 'http': {
        const routes = await loadHttpRoutes(project, spec.spec);
        return { actions: normalizeHttp(routes), server: spec.baseUrl };
      }
      case 'graphql': {
        const introspection = await introspectGraphql(spec.endpoint!);
        return { actions: normalizeGraphql(introspection), server: spec.endpoint };
      }
      case 'mcp': {
        const tools = await listMcpTools(spec.url!, spec.transport ?? 'http');
        return { actions: normalizeMcp(tools), server: spec.url };
      }
      case 'pipedream': {
        if (!pipedreamConfigured() || !spec.app) return { actions: [], server: null };
        const raw = await pipedreamCatalog(spec.app);
        return { actions: normalizePipedream(raw, spec.app), server: null };
      }
      default:
        return { actions: [], server: null };
    }
  } catch (e) {
    return { actions: [], server: null, error: (e as Error).message };
  }
}

async function loadSpecDoc(project: GitBackedProject, spec: string): Promise<any> {
  const raw = /^https?:\/\//i.test(spec)
    ? await (await fetch(spec)).text()
    : await readRepoFile(project, spec, project.defaultBranch);
  try {
    return JSON.parse(raw);
  } catch {
    // YAML specs would need a YAML parser; JSON is the supported P0 format.
    throw new Error('spec is not valid JSON (YAML specs not yet supported)');
  }
}

async function loadHttpRoutes(project: GitBackedProject, spec: string | null): Promise<HttpRouteSpec[]> {
  if (!spec) return [];
  const raw = /^https?:\/\//i.test(spec)
    ? await (await fetch(spec)).text()
    : await readRepoFile(project, spec, project.defaultBranch);
  const parsed = /\.toml$/i.test(spec) ? (parseToml(raw) as any) : JSON.parse(raw);
  const routes = Array.isArray(parsed?.routes) ? parsed.routes : [];
  return routes as HttpRouteSpec[];
}

async function introspectGraphql(endpoint: string): Promise<any> {
  const query = `query{__schema{queryType{name} mutationType{name} types{name fields{name description args{name type{kind name ofType{name}}} type{name ofType{name}}}}}}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

/**
 * Replace the project's [[policies]] + [policy].default_mode with what
 * kortix.toml currently declares. Delete-then-insert (the manifest is the
 * source of truth, so we don't preserve DB-only edits). Cheap — runs every
 * sync, no network call.
 */
async function reconcileProjectPolicies(
  projectId: string,
  parsed: { policies: { match: string; action: 'always_run' | 'require_approval' | 'block' }[]; settings: { defaultMode: 'risk' | 'allow_all' } },
): Promise<void> {
  await db.delete(executorProjectPolicies).where(eq(executorProjectPolicies.projectId, projectId));
  const rows = toProjectPolicyRows(parsed.policies);
  if (rows.length > 0) {
    await db.insert(executorProjectPolicies).values(
      rows.map((p) => ({ projectId, match: p.match, action: p.action, position: p.position })),
    );
  }
  // Upsert default_mode (one row per project).
  await db
    .insert(executorProjectSettings)
    .values({ projectId, defaultMode: parsed.settings.defaultMode })
    .onConflictDoUpdate({
      target: executorProjectSettings.projectId,
      set: { defaultMode: parsed.settings.defaultMode, updatedAt: new Date() },
    });
}

const nodeFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

async function listMcpTools(url: string, transport: McpTransport): Promise<any[]> {
  const result = await performMcpJsonRpc({
    url,
    method: 'tools/list',
    params: {},
    transport,
    fetchImpl: nodeFetch,
  });
  if (!result.ok) {
    const reason = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data ?? {});
    throw new Error(reason || `MCP tools/list failed (${result.status})`);
  }
  return (result.data as any)?.result?.tools ?? [];
}
