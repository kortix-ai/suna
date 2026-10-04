/**
 * Marketplace install — project-scoped, agent-driven.
 *
 *   POST /:projectId/marketplace/install-session { id } → start a session that
 *     clones/reads the marketplace item's source and merges it into this
 *     project (skills/agents/tools/kortix.yaml), then opens a CR.
 *
 * The deterministic install/lock/update/remove engine (registry-lock.json,
 * dependency resolution, hash-based update detection) has been removed.
 * Adding a marketplace item
 * to an existing project is now always an agent import; no file is ever
 * committed without the agent reading + wiring it in first.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import {
  accountMayUseManagedModels,
  getCachedAccountTier,
} from '../../billing/services/entitlements';
import { isPaidTier } from '../../billing/services/tiers';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { resolveEffectiveModel } from '../../llm-gateway/resolution/default-model';
import { getCatalogEntry } from '../../marketplace/catalog';
import { auth, errors, json, lenientBody } from '../../openapi';
import { readJsonObject } from '../../lib/http-body';
import { readManifestFromRepo } from '../../services/git/files';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { loadGitProject } from '../../services/git/project-git';
import { normalizeString, requestAuditContext } from '../lib/serializers';
import { sendSessionCreateError } from '../../services/sessions/sessions';
import { createSession } from '../../services/sessions/lifecycle';
import {
  buildRegistryProjectInstallPrompt,
  buildTemplateInstallPrompt,
} from './marketplace-install-prompts';

/** The project's manifest raw text, preferring kortix.yaml over kortix.toml
 *  (dual-format). */
async function manifestRawOrNull(
  project: Parameters<typeof readManifestFromRepo>[0],
): Promise<string | null> {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((cand) => cand.path),
    project.defaultBranch,
  ).catch(() => null);
  return found?.content ?? null;
}

/** Agent-driven install of a skill/agent/command/tool into THIS project: the
 *  session installs its files, then wires up whatever it needs (connectors,
 *  secrets). */
function buildItemInstallPrompt(
  entry: NonNullable<Awaited<ReturnType<typeof getCatalogEntry>>>,
  id: string,
): string {
  const item = entry.item;
  const typeLabel = item.type.replace('registry:', '');
  const meta = (item.meta ?? {}) as {
    capabilities?: { connectors?: string[]; secrets?: string[] };
  };
  const needs = [
    ...(meta.capabilities?.connectors ?? []),
    ...(meta.capabilities?.secrets ?? []),
    ...Object.keys((item as { envVars?: Record<string, unknown> }).envVars ?? {}),
  ];
  const lines: string[] = [
    `Add the "${item.title ?? item.name}" ${typeLabel} to THIS project and set it up.`,
    '',
    item.description ?? '',
    '',
    'Steps:',
    `1. Fetch its source (marketplace item id "${id}") — read its files (SKILL.md / agent / tool definition) and place them into this project, following the project's existing conventions.`,
    '2. Read its SKILL.md (or equivalent) to see what it does and what it needs.',
  ];
  if (needs.length) {
    lines.push(
      `3. It needs these connected: ${needs.join(', ')}. Mint a setup link with the \`request_secret\` / \`connect\` tools (or \`kortix secrets request\` / \`kortix connectors link\`) — never ask me to paste a raw key.`,
      '4. Tell me in one line what it can now do and how to use it.',
    );
  } else {
    lines.push('3. Tell me in one line what it can now do and how to use it.');
  }
  return lines.join('\n');
}

/**
 * The install session's import turn is a real agent turn on the session's
 * model. When the account may not use managed models (a free tier, or a plan
 * that does not bundle managed inference) and nothing the session would pin is
 * servable, that turn can only die with the platform default's plan error —
 * the customer sees an internal model id and a dead session (KRTX-1540).
 * Refuse the install here, where the remedy is one line, instead.
 *
 * Servable for the turn means: the account may use managed models (the box
 * boots its catalog default, a managed id), or the account/project default the
 * session would pin is servable (the account's own key). The agent layer is
 * resolved from the metadata mirror only — loading the manifest agents here
 * would duplicate session-create's work for a case the mirror covers.
 * Native (gateway-off) projects have no plan gate: the box runs OpenCode's own
 * providers from the project's keys.
 */
async function installModelGate(
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
): Promise<{ status: 402; body: { error: string; code: string } } | null> {
  if (!projectLlmGatewayEnabled(loaded.row.metadata)) return null;
  if (await accountMayUseManagedModels(loaded.row.accountId)) return null;
  const mirroredDefaultAgent = normalizeString(
    (loaded.row.metadata as Record<string, unknown> | null | undefined)?.default_agent,
  );
  const resolved = await resolveEffectiveModel({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId: loaded.row.projectId,
    ...(mirroredDefaultAgent ? { agentName: mirroredDefaultAgent } : {}),
    explicit: null,
    freeModelsOnly: true,
    // A shared session (visibility 'project') reaches project-wide keys only
    // (spec 2026-09-22 §2.3) — the install session is always shared.
    personalUserId: null,
  });
  if (resolved.model) return null;
  const tier = await getCachedAccountTier(loaded.row.accountId);
  const error = isPaidTier(tier ?? 'free')
    ? 'Marketplace installs run an agent import that needs a model. This plan does not ' +
      'include managed models — add your own provider key, then install again.'
    : 'Marketplace installs run an agent import that needs a model. Managed models require ' +
      'a paid plan — upgrade your plan or connect a provider key, then install again.';
  return { status: 402, body: { error, code: 'no_servable_model' } };
}

async function handleMarketplaceInstallSession(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Flag gate AFTER membership authz. `marketplace` defaults ON platform-wide,
  // so this only rejects a project that explicitly turned it off.
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'marketplace');
  if (gate) return gate;

  const body = await readJsonObject(c);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ error: 'id is required' }, 400);

  const entry = await getCatalogEntry(id);
  if (!entry) return c.json({ error: `Unknown item "${id}"` }, 400);

  const modelGate = await installModelGate(loaded);
  if (modelGate) return c.json(modelGate.body, modelGate.status);

  const project = await loadGitProject(loaded);
  let prompt: string;
  try {
    // Whole projects get merged (judgment-heavy, guards the target's kortix.yaml);
    // a use-case template renders inputs + wires its scheduled trigger; everything
    // else is a straight install + setup.
    if (entry.item.type === 'registry:project') {
      prompt = buildRegistryProjectInstallPrompt(entry, await manifestRawOrNull(project));
    } else if (entry.item.type === 'registry:template') {
      prompt = buildTemplateInstallPrompt(entry, id);
    } else {
      prompt = buildItemInstallPrompt(entry, id);
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const result = await createSession({
    source: 'ui',
    project: loaded.row,
    userId: loaded.userId,
    requestingPrincipalType: c.get('authType') === 'service_account' ? 'service_account' : 'human',
    body: {
      initial_prompt: prompt,
      name: `Add ${entry.item.title ?? entry.item.name}`,
      metadata: { kind: 'marketplace-install', item_id: id },
    },
    visibility: 'project',
    // Derive origin from the caller's token kind, same as POST /sessions (project-sessions.ts),
    // so a backend-driven install records origin='backend' rather than 'user'.
    authType: c.get('authType') as string | undefined,
    apiKeyType: c.get('apiKeyType') as string | undefined,
    inSession: isProjectSessionPrincipal(c),
    request: requestAuditContext(c),
    queuePolicy: 'never',
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

  return c.json({ session_id: result.row.sessionId }, 201);
}
export function registerMarketplaceInstallSessionRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/marketplace/install-session',
      tags: ['marketplace'],
      summary: 'Start a session that installs a marketplace item',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: lenientBody({
                id: z.string().openapi({ description: 'Marketplace item id to install.' }),
              }),
            },
          },
        },
      },
      responses: {
        201: json(z.any(), 'Session started'),
        ...errors(400, 402, 403, 404),
      },
    }),
    handleMarketplaceInstallSession,
  );
}
