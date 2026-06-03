/**
 * Connector CRUD that round-trips `kortix.toml` — the web UI "Add connector"
 * flow (mirrors triggers/apps). The manifest holds the connector definition +
 * credential MODE (shared/per_user, a static per-app default). ACCESS (who can
 * use) is dynamic and stored on the connector (not git). Credentials live in the
 * split store.
 */
import { and, eq } from 'drizzle-orm';
import { executorConnectors, projects } from '@kortix/db';
import { db } from '../shared/db';
import { commitManifest, loadManifestForEdit } from '../projects/index';
import { extractConnectors } from '../projects/connectors';
import {
  extractProjectPolicies,
  projectPoliciesToTomlEntries,
  projectPolicySettingsToToml,
  type ProjectPolicySpec,
} from '../projects/policies';
import type { DefaultMode } from './policy';
import { syncProjectConnectors, type SyncResult } from './sync';
import { setConnectorSharingDb, upsertCredential } from './credentials';
import type { SharingIntent } from './share';

export interface ConnectorDraft {
  slug: string;
  name?: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';
  app?: string;
  account?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  baseUrl?: string;
  spec?: string;
  /** Credential storage mode — default per app (pipedream→per_user, else shared). */
  credential?: 'shared' | 'per_user';
  auth?: { type?: 'none' | 'bearer' | 'basic' | 'custom'; in?: 'header' | 'query'; name?: string; prefix?: string };
}

type CrudResult =
  | { ok: true; sync?: SyncResult }
  | { ok: false; error: string; status: number };

function draftToEntry(d: ConnectorDraft): Record<string, unknown> {
  const entry: Record<string, unknown> = { slug: d.slug, provider: d.provider };
  if (d.name) entry.name = d.name;
  if (d.credential) entry.credential = d.credential;
  if (d.provider === 'pipedream') {
    if (d.app) entry.app = d.app;
    if (d.account) entry.account = d.account;
  } else if (d.provider === 'mcp') {
    if (d.url) entry.url = d.url;
    if (d.transport) entry.transport = d.transport;
  } else if (d.provider === 'graphql') {
    if (d.endpoint) entry.endpoint = d.endpoint;
    if (d.spec) entry.spec = d.spec;
  } else if (d.provider === 'http') {
    if (d.baseUrl) entry.base_url = d.baseUrl;
    if (d.spec) entry.spec = d.spec;
  } else if (d.provider === 'openapi') {
    if (d.spec) entry.spec = d.spec;
  }
  if (d.auth && d.auth.type && d.auth.type !== 'none') {
    const auth: Record<string, unknown> = { type: d.auth.type };
    if (d.auth.type === 'custom') {
      if (d.auth.in && d.auth.in !== 'header') auth.in = d.auth.in;
      if (d.auth.name) auth.name = d.auth.name;
    }
    if (d.auth.prefix) auth.prefix = d.auth.prefix;
    entry.auth = auth;
  }
  return entry;
}

async function loadRow(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return row ?? null;
}

async function connectorIdFor(projectId: string, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  return row?.connectorId ?? null;
}

/** Create/update a connector in kortix.toml, materialize it, then apply access. */
export async function upsertConnectorInManifest(
  projectId: string,
  accountId: string,
  draft: ConnectorDraft,
  sharing?: SharingIntent,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const entry = draftToEntry(draft);
  const current = Array.isArray(manifest.raw.connectors) ? (manifest.raw.connectors as Record<string, unknown>[]) : [];
  const idx = current.findIndex((c) => c?.slug === draft.slug);
  if (idx >= 0) current[idx] = entry;
  else current.push(entry);
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === draft.slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(row, manifest, `chore: ${idx >= 0 ? 'update' : 'add'} connector ${draft.slug}`);
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  const sync = await syncProjectConnectors(projectId, accountId);

  // Apply access (who can use) — dynamic, lives on the connector, not in git.
  if (sharing) {
    const connectorId = await connectorIdFor(projectId, draft.slug);
    if (connectorId) await setConnectorSharingDb(connectorId, sharing);
  }
  return { ok: true, sync };
}

export async function deleteConnectorFromManifest(projectId: string, slug: string): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors) ? (manifest.raw.connectors as Record<string, unknown>[]) : [];
  const next = current.filter((c) => c?.slug !== slug);
  if (next.length === current.length) {
    await db.delete(executorConnectors).where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)));
    return { ok: true };
  }
  manifest.raw.connectors = next;
  const committed = await commitManifest(row, manifest, `chore: delete connector ${slug}`);
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };
  await db.delete(executorConnectors).where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)));
  return { ok: true };
}

/** Set the SHARED credential value (userId null). Per-user creds come via the connect flow. */
export async function setConnectorCredentialShared(projectId: string, slug: string, value: string): Promise<CrudResult> {
  const connectorId = await connectorIdFor(projectId, slug);
  if (!connectorId) return { ok: false, error: 'connector not found', status: 404 };
  await upsertCredential({ projectId, connectorId, userId: null, value, kind: 'secret' });
  return { ok: true };
}

// ─── Project-level policies (top-level [[policies]] + [policy]) ──────────────

interface ProjectPoliciesView {
  policies: ProjectPolicySpec[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
}

/** Read the project's [[policies]] + [policy] block (kortix.toml = source of truth). */
export async function getProjectPoliciesFromManifest(projectId: string): Promise<ProjectPoliciesView | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return { policies: [], defaultMode: 'allow_all', errors: [] };
  const parsed = extractProjectPolicies(manifest);
  return { policies: parsed.policies, defaultMode: parsed.settings.defaultMode, errors: parsed.errors };
}

/**
 * Replace the WHOLE [[policies]] array + [policy].default_mode in kortix.toml,
 * commit, and re-sync so the runtime tables reflect the new posture. The UI is
 * an ordered list; "save" PUTs the whole list back. Per-rule add/edit/delete
 * remain client-side until commit.
 */
export async function setProjectPoliciesInManifest(
  projectId: string,
  accountId: string,
  policies: ProjectPolicySpec[],
  defaultMode: DefaultMode,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  // Validate against the parser before writing — same rules the runtime enforces.
  for (const [i, p] of policies.entries()) {
    if (!p.match || typeof p.match !== 'string') {
      return { ok: false, error: `policy #${i + 1}: \`match\` is required`, status: 400 };
    }
    if (p.action !== 'always_run' && p.action !== 'require_approval' && p.action !== 'block') {
      return { ok: false, error: `policy #${i + 1}: \`action\` must be always_run | require_approval | block`, status: 400 };
    }
  }
  if (defaultMode !== 'risk' && defaultMode !== 'allow_all') {
    return { ok: false, error: '`default_mode` must be risk | allow_all', status: 400 };
  }

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  // Rewrite both knobs. Omit empties so the manifest stays clean.
  const entries = projectPoliciesToTomlEntries(policies);
  if (entries.length > 0) {
    manifest.raw.policies = entries;
  } else {
    delete manifest.raw.policies;
  }
  const settingsBlock = projectPolicySettingsToToml({ defaultMode });
  if (settingsBlock) {
    manifest.raw.policy = settingsBlock;
  } else {
    delete manifest.raw.policy;
  }

  const committed = await commitManifest(row, manifest, 'chore: update executor policies');
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  // Materialize: project policies are reconciled inside syncProjectConnectors.
  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}
