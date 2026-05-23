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
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { withProjectGitAuth } from '../projects/index';
import { readManifest } from '../projects/triggers';
import { readRepoFile, type GitBackedProject } from '../projects/git';
import { extractConnectors, manifestHashForConnector, type ConnectorSpec } from '../projects/connectors';
import {
  normalizeGraphql,
  normalizeHttp,
  normalizeMcp,
  normalizeOpenApi,
  normalizePipedream,
} from './normalize';
import type { NormalizedAction, HttpRouteSpec } from './types';
import { parseResponseBody } from './execute';
import { connectorConfig, toPolicyRows } from './materialize';
import { pipedreamCatalog, pipedreamConfigured } from './pipedream';

export interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
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
export async function syncProjectConnectors(projectId: string, accountId: string): Promise<SyncResult> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { synced: 0, errors: [{ slug: '(project)', error: 'project not found' }] };

  const gitProject = await withProjectGitAuth(row);
  const manifest = await readManifest(gitProject).catch(() => null);
  if (!manifest) return { synced: 0, errors: [{ slug: '(manifest)', error: 'kortix.toml not found or unreadable' }] };

  const { specs, errors: parseErrors } = extractConnectors(manifest);
  const errors: SyncResult['errors'] = parseErrors.map((e) => ({ slug: e.slug, error: e.error }));

  const existing = await db
    .select({ slug: executorConnectors.slug, connectorId: executorConnectors.connectorId, manifestHash: executorConnectors.manifestHash })
    .from(executorConnectors)
    .where(eq(executorConnectors.projectId, projectId));
  const existingBySlug = new Map(existing.map((e) => [e.slug, e]));
  const desiredSlugs = new Set(specs.map((s) => s.slug));

  let synced = 0;
  for (const spec of specs) {
    try {
      const catalog = await resolveCatalog(gitProject, spec);
      await upsertConnector(projectId, accountId, spec, catalog, existingBySlug.get(spec.slug)?.connectorId ?? null);
      if (catalog.error) errors.push({ slug: spec.slug, error: catalog.error });
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

/** Upsert one connector + replace its actions + policies. */
async function upsertConnector(
  projectId: string,
  accountId: string,
  spec: ConnectorSpec,
  catalog: ResolvedCatalog,
  existingId: string | null,
): Promise<void> {
  const config = connectorConfig(spec, catalog.server);
  const manifestHash = manifestHashForConnector(spec);
  const status = catalog.error ? 'error' : spec.enabled ? 'active' : 'disabled';
  // Credentials live in executor_credentials now; authSecret is legacy (kept nullable).
  const authSecret = spec.auth.secret ?? null;
  const credentialMode = spec.credentialMode;

  let connectorId = existingId;
  if (connectorId) {
    await db
      .update(executorConnectors)
      .set({
        name: spec.name,
        providerType: spec.provider,
        enabled: spec.enabled,
        config,
        authSecret,
        credentialMode,
        manifestHash,
        status,
        lastError: catalog.error ?? null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(executorConnectors.connectorId, connectorId));
  } else {
    const [created] = await db
      .insert(executorConnectors)
      .values({
        accountId,
        projectId,
        slug: spec.slug,
        name: spec.name,
        providerType: spec.provider,
        enabled: spec.enabled,
        config,
        authSecret,
        credentialMode,
        manifestHash,
        status,
        lastError: catalog.error ?? null,
        lastSyncedAt: new Date(),
      })
      .returning({ connectorId: executorConnectors.connectorId });
    connectorId = created!.connectorId;
  }

  // Replace actions (relative paths) + policies wholesale — simplest correct sync.
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
        const tools = await listMcpTools(spec.url!);
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

async function listMcpTools(url: string): Promise<any[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  // Streamable-HTTP MCP responds with SSE-framed JSON, not plain JSON.
  const json: any = parseResponseBody(await res.text());
  return json?.result?.tools ?? [];
}
