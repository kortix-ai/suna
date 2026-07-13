import {
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectorPolicies,
  executorConnectors,
  executorProjectPolicies,
  executorProjectSettings,
  projectSessionConnectorBindings,
  projects,
} from '@kortix/db';
/**
 * Connector materialization sweep — read `connectors:` from kortix.yaml,
 * fetch + normalize each connector's catalog, and upsert into the DB
 * (executor_connectors / _actions / _policies). Definitions live in git
 * (manifest = source of truth, like triggers); this populates the runtime view
 * the gateway + dashboard read. Catalog fetch is best-effort per connector:
 * a connector that can't be reached is stored with status='error' + 0 actions,
 * never failing the whole sweep. See docs/specs/executor.md §3, §7.
 */
import { and, eq, sql } from 'drizzle-orm';
import { parse as parseToml } from 'smol-toml';
import {
  listAgentMailInstalls,
  loadSlackInstall,
  loadTelegramInstall,
} from '../channels/install-store';
import { resolveExperimentalFeature } from '../experimental/features';
import { assertAllowedSourceAddress } from '../marketplace/catalog';
import {
  type ConnectorSpec,
  extractConnectors,
  manifestHashForConnector,
} from '../projects/connectors';
import { type GitBackedProject, readRepoFile } from '../projects/git';
import { withProjectGitAuth } from '../projects/index';
import { extractProjectPolicies } from '../projects/policies';
import { readManifest } from '../projects/triggers';
import { db } from '../shared/db';
import { ensureChannelConnectorDeclared, removeChannelConnectorDeclared } from './channel-manifest';
import { synthesizeChannelConnectors } from './channel-materialize';
import { channelApiBase, channelCatalog, channelDefaultSlug } from './channels';
import { synthesizeComputerConnectors } from './computer-materialize';
import { computerCatalog } from './computers';
import { ensureDefaultProfile } from './credentials';
import { parseResponseBody } from './execute';
import { connectorConfig, toPolicyRows, toProjectPolicyRows } from './materialize';
import {
  normalizeGraphql,
  normalizeHttp,
  normalizeMcp,
  normalizeOpenApi,
  normalizePipedream,
} from './normalize';
import { pipedreamCatalog, pipedreamConfigured } from './pipedream';
import { parseSpecDocument } from './spec-doc';
import type { HttpRouteSpec, NormalizedAction } from './types';

export interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

/**
 * Best-effort re-materialization after a channel platform install changes
 * (connect / disconnect). Persists the channel connector as a first-class
 * kortix.yaml profile (or removes it on disconnect), then runs the normal sweep
 * so it (dis)appears immediately — "connect Slack → the Slack connector shows
 * up". The kortix.yaml write is best-effort: synthesizeChannelConnectors still
 * materializes the connector from the install, so a read-only / unreachable repo
 * keeps working. Never throws: a hiccup must not fail the install/uninstall.
 */
export async function reconcileChannelConnectors(
  projectId: string,
  removed?: { platform: 'email'; slug: string },
): Promise<void> {
  try {
    const [row] = await db
      .select({ accountId: projects.accountId, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!row) return;
    const slackInstalled = (await loadSlackInstall(projectId).catch(() => null)) != null;
    if (slackInstalled) await ensureChannelConnectorDeclared(projectId, 'slack');
    else await removeChannelConnectorDeclared(projectId, 'slack');

    const telegramInstalled = (await loadTelegramInstall(projectId).catch(() => null)) != null;
    if (telegramInstalled) await ensureChannelConnectorDeclared(projectId, 'telegram');
    else await removeChannelConnectorDeclared(projectId, 'telegram');

    const emailEnabled = resolveExperimentalFeature(row.metadata, 'agentmail_email');
    if (removed?.platform === 'email' || !emailEnabled) {
      await removeChannelConnectorDeclared(projectId, 'email', removed?.slug);
    }
    if (emailEnabled) {
      const emailInstalls = await listAgentMailInstalls(projectId).catch(() => []);
      for (const install of emailInstalls) {
        await ensureChannelConnectorDeclared(
          projectId,
          'email',
          install.profileSlug,
          install.displayName || install.email || 'Email',
        );
      }
      if (emailInstalls.length === 0) await removeChannelConnectorDeclared(projectId, 'email');
    }
    await syncProjectConnectors(projectId, row.accountId);
  } catch (e) {
    console.warn('[executor] channel connector reconcile failed', {
      projectId,
      err: (e as Error).message,
    });
  }
}

/**
 * Best-effort re-materialization after a tunnel (computer) changes for an
 * ACCOUNT (machine connected / removed). Tunnels are account-scoped but
 * connectors are project-scoped, so the single `computer` connector must be
 * (un)materialized across every project of the account — fan out a sync to each.
 * The connector exists iff the account has ≥1 machine, so this is idempotent.
 * Never throws: a sync hiccup must not fail the connect/remove request.
 * (Machines coming/going *within* an existing connector need no resync —
 * `list_computers` is always live.)
 */
export async function reconcileComputerConnectors(accountId: string): Promise<void> {
  try {
    const rows = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.accountId, accountId));
    for (const r of rows) {
      await syncProjectConnectors(r.projectId, accountId);
    }
  } catch (e) {
    console.warn('[executor] computer connector reconcile failed', {
      accountId,
      err: (e as Error).message,
    });
  }
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
 * git auth (so private repos resolve), reads kortix.yaml, then upserts.
 */
export async function syncProjectConnectors(
  projectId: string,
  _accountId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { synced: 0, errors: [{ slug: '(project)', error: 'project not found' }] };
  const accountId = row.accountId;

  const gitProject = await withProjectGitAuth(row);
  const manifest = await readManifest(gitProject).catch(() => null);

  // Manifest-declared connectors + project policies are only reconciled when the
  // kortix.yaml is actually readable. A NULL manifest can mean "no repo / no
  // kortix.yaml" OR a transient git error — either way we must not treat it as
  // "zero declared connectors" and delete the project's real ones below.
  const errors: SyncResult['errors'] = [];
  let declaredSpecs: ConnectorSpec[] = [];
  if (manifest) {
    const parsed = extractConnectors(manifest);
    declaredSpecs = parsed.specs;
    errors.push(...parsed.errors.map((e) => ({ slug: e.slug, error: e.error })));

    // Project-level policies + settings — separate scope, reconciled (cheap).
    const projectPoliciesParsed = extractProjectPolicies(manifest);
    for (const e of projectPoliciesParsed.errors) {
      errors.push({ slug: '(policies)', error: e.error });
    }
    await reconcileProjectPolicies(projectId, projectPoliciesParsed);
  }

  // Channel connectors (e.g. Slack) are INSTALL-driven, not manifest-driven:
  // connecting the platform IS the registration. So they materialize even when
  // the project has no readable kortix.yaml — "connect Slack → the `slack`
  // connector just appears" must hold for any project. Synthetic specs are
  // materialized like any other connector but never written back to git.
  const channelSpecs = await synthesizeChannelConnectors(projectId, declaredSpecs);
  // Computer connector (the Agent Computer Tunnel) is install-driven the same
  // way: a single synthetic connector when the account has a connected machine.
  // A regular connector — no experimental opt-in — also manifest-independent.
  const computerSpecs = await synthesizeComputerConnectors(projectId, declaredSpecs);
  const specs = [...declaredSpecs, ...channelSpecs, ...computerSpecs];

  // No readable manifest AND nothing installed → bail WITHOUT deleting (a
  // transient git error must never wipe a project's connectors).
  if (!manifest && channelSpecs.length === 0 && computerSpecs.length === 0) {
    return {
      synced: 0,
      errors: [{ slug: '(manifest)', error: 'kortix.yaml not found or unreadable' }],
    };
  }

  const existing = await db
    .select({
      slug: executorConnectors.slug,
      connectorId: executorConnectors.connectorId,
      manifestHash: executorConnectors.manifestHash,
      status: executorConnectors.status,
      providerType: executorConnectors.providerType,
    })
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
        !opts.force &&
        !!ex &&
        ex.status !== 'error' &&
        ex.manifestHash === manifestHashForConnector(spec);
      const catalog = catalogUnchanged ? null : await resolveCatalog(gitProject, spec);
      await upsertConnector(projectId, accountId, spec, catalog, ex?.connectorId ?? null);
      if (catalog?.error) errors.push({ slug: spec.slug, error: catalog.error });
      synced++;
    } catch (e) {
      errors.push({ slug: spec.slug, error: (e as Error).message });
    }
  }

  await reconcileEmailConnectionProfiles(projectId, accountId);

  // Reconcile deletions. When the manifest is readable it's the source of truth
  // for declared connectors — drop any it no longer lists (channel specs are in
  // desiredSlugs, so they're kept). When the manifest is UNREADABLE we must not
  // touch manifest-declared connectors (could be a transient git error) — only
  // reconcile CHANNEL rows whose install is gone, so a disconnect still cleans up.
  for (const e of existing) {
    if (desiredSlugs.has(e.slug)) continue;
    if (manifest || e.providerType === 'channel' || e.providerType === 'computer') {
      const [bound] = await db
        .select({ sessionId: projectSessionConnectorBindings.sessionId })
        .from(projectSessionConnectorBindings)
        .where(eq(projectSessionConnectorBindings.connectorId, e.connectorId))
        .limit(1);
      if (bound) {
        await db
          .update(executorConnectors)
          .set({ enabled: false, status: 'disabled', updatedAt: new Date() })
          .where(eq(executorConnectors.connectorId, e.connectorId));
      } else {
        await db
          .delete(executorConnectors)
          .where(eq(executorConnectors.connectorId, e.connectorId));
      }
    }
  }

  return { synced, errors };
}

export async function reconcileEmailConnectionProfiles(
  projectId: string,
  accountId: string,
): Promise<void> {
  const installs = await listAgentMailInstalls(projectId).catch(() => []);
  const canonicalSlug = channelDefaultSlug('email');
  const [connector] = await db
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(
      and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, canonicalSlug)),
    )
    .limit(1);
  if (!connector) return;
  await ensureDefaultProfile({ projectId, connectorId: connector.connectorId });
  const activeOwnerIds = new Set(installs.map((install) => `agentmail:${install.inboxId}`));
  const existingEmailProfiles = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      ownerId: executorConnectionProfiles.ownerId,
    })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.connectorId, connector.connectorId),
        eq(executorConnectionProfiles.ownerType, 'external'),
      ),
    );
  for (const existing of existingEmailProfiles) {
    if (existing.ownerId?.startsWith('agentmail:') && !activeOwnerIds.has(existing.ownerId)) {
      await db
        .update(executorConnectionProfiles)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(executorConnectionProfiles.profileId, existing.profileId));
    }
  }

  for (const install of installs) {
    const ownerId = `agentmail:${install.inboxId}`;
    const [existing] = await db
      .select({ profileId: executorConnectionProfiles.profileId })
      .from(executorConnectionProfiles)
      .where(
        and(
          eq(executorConnectionProfiles.connectorId, connector.connectorId),
          eq(executorConnectionProfiles.ownerType, 'external'),
          eq(executorConnectionProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    const values = {
      label: install.displayName || install.email,
      status: 'active' as const,
      metadata: {
        connector_slug: install.profileSlug,
        inbox_id: install.inboxId,
        email: install.email,
        channel_profile: true,
      },
      updatedAt: new Date(),
    };
    if (existing) {
      await db
        .update(executorConnectionProfiles)
        .set(values)
        .where(eq(executorConnectionProfiles.profileId, existing.profileId));
    } else {
      await db.insert(executorConnectionProfiles).values({
        accountId,
        projectId,
        connectorId: connector.connectorId,
        ownerType: 'external',
        ownerId,
        isDefault: false,
        ...values,
      });
    }
  }
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
    // `sensitive` lives inside `config` but is a CHEAP field: it isn't part of
    // manifestHashForConnector (deliberately — flipping it must not force a
    // catalog re-fetch), so on a hash-match reconcile we still patch that one
    // key in place. Without this, the Sensitive toggle commits to kortix.yaml
    // but the DB config (what the gateway + admin UI read) never updates.
    const sensitivePatch = spec.sensitive
      ? sql`coalesce(${executorConnectors.config}, '{}'::jsonb) || '{"sensitive": true}'::jsonb`
      : sql`coalesce(${executorConnectors.config}, '{}'::jsonb) - 'sensitive'`;
    await db
      .update(executorConnectors)
      .set(
        catalog
          ? { ...common, config: connectorConfig(spec, catalog.server) }
          : { ...common, config: sensitivePatch },
      )
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

  await ensureDefaultProfile({ projectId, connectorId });

  // Actions only change when the catalog was re-resolved — leave them in place
  // on a cheap reconcile.
  if (catalog) {
    await db
      .delete(executorConnectorActions)
      .where(eq(executorConnectorActions.connectorId, connectorId));
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
  await db
    .delete(executorConnectorPolicies)
    .where(eq(executorConnectorPolicies.connectorId, connectorId));
  const policyRows = toPolicyRows(spec);
  if (policyRows.length > 0) {
    await db.insert(executorConnectorPolicies).values(
      policyRows.map((p) => ({
        connectorId: connectorId!,
        match: p.match,
        action: p.action,
        position: p.position,
      })),
    );
  }
}

/** Fetch + normalize a connector's catalog. Best-effort; never throws. */
export async function resolveCatalog(
  project: GitBackedProject,
  spec: ConnectorSpec,
): Promise<ResolvedCatalog> {
  try {
    switch (spec.provider) {
      case 'openapi': {
        const doc = await loadSpecDoc(project, spec.spec!);
        let server =
          Array.isArray(doc?.servers) && doc.servers[0]?.url ? String(doc.servers[0].url) : null;
        // Specs often use a relative server (e.g. Petstore's "/api/v3"); resolve
        // it against the spec URL's origin so the gateway has an absolute base.
        if (server && server.startsWith('/') && /^https?:\/\//i.test(spec.spec!)) {
          try {
            server = new URL(server, spec.spec!).href.replace(/\/$/, '');
          } catch {
            /* keep */
          }
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
      case 'channel': {
        // Fixed, local catalog — no network fetch. Server = the platform API base.
        return {
          actions: channelCatalog(spec.platform ?? ''),
          server: channelApiBase(spec.platform ?? ''),
        };
      }
      case 'computer': {
        // Fixed, local catalog (the tunnel RPC method set) — no network, no
        // server. Machines are resolved at call time, not from a base URL.
        return { actions: computerCatalog(), server: null };
      }
      default:
        return { actions: [], server: null };
    }
  } catch (e) {
    return { actions: [], server: null, error: (e as Error).message };
  }
}

async function loadSpecDoc(project: GitBackedProject, spec: string): Promise<any> {
  let raw: string;
  if (/^https?:\/\//i.test(spec)) {
    assertAllowedSourceAddress(spec);
    const res = await fetch(spec, {
      // Signal we accept either form; servers that content-negotiate may hand
      // back JSON, but we parse whatever comes regardless.
      headers: { accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
    });
    if (!res.ok) {
      throw new Error(`failed to fetch spec at ${spec}: HTTP ${res.status} ${res.statusText}`);
    }
    raw = await res.text();
  } else {
    raw = await readRepoFile(project, spec, project.defaultBranch);
  }
  return parseSpecDocument(raw, spec);
}

async function loadHttpRoutes(
  project: GitBackedProject,
  spec: string | null,
): Promise<HttpRouteSpec[]> {
  if (!spec) return [];
  if (/^https?:\/\//i.test(spec)) assertAllowedSourceAddress(spec);
  const raw = /^https?:\/\//i.test(spec)
    ? await (await fetch(spec)).text()
    : await readRepoFile(project, spec, project.defaultBranch);
  const parsed = /\.toml$/i.test(spec) ? (parseToml(raw) as any) : JSON.parse(raw);
  const routes = Array.isArray(parsed?.routes) ? parsed.routes : [];
  return routes as HttpRouteSpec[];
}

async function introspectGraphql(endpoint: string): Promise<any> {
  assertAllowedSourceAddress(endpoint);
  const query = `query{__schema{queryType{name} mutationType{name} types{name fields{name description args{name type{kind name ofType{name}}} type{name ofType{name}}}}}}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

/**
 * Replace the project's `policies:` list + `policy.default_mode` with what
 * kortix.yaml currently declares. Delete-then-insert (the manifest is the
 * source of truth, so we don't preserve DB-only edits). Cheap — runs every
 * sync, no network call.
 */
async function reconcileProjectPolicies(
  projectId: string,
  parsed: {
    policies: { match: string; action: 'always_run' | 'require_approval' | 'block' }[];
    settings: { defaultMode: 'risk' | 'allow_all' };
  },
): Promise<void> {
  await db.delete(executorProjectPolicies).where(eq(executorProjectPolicies.projectId, projectId));
  const rows = toProjectPolicyRows(parsed.policies);
  if (rows.length > 0) {
    await db
      .insert(executorProjectPolicies)
      .values(
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

async function listMcpTools(url: string): Promise<any[]> {
  assertAllowedSourceAddress(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  // Streamable-HTTP MCP responds with SSE-framed JSON, not plain JSON.
  const json: any = parseResponseBody(await res.text());
  return json?.result?.tools ?? [];
}
