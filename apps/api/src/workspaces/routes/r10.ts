/**
 * Marketplace install — workspace-scoped, agent-driven.
 *
 *   POST /:workspaceId/marketplace/install-session { id } → start a session that
 *     clones/reads the marketplace item's source and merges it into this
 *     project (skills/agents/tools/kortix.yaml), then opens a CR.
 *
 * The deterministic install/lock/update/remove engine (registry-lock.json,
 * dependency resolution, hash-based update detection) has been removed — see
 * docs/specs/2026-07-13-marketplace-as-projects.md. Adding a marketplace item
 * to an existing project is now always an agent import; no file is ever
 * committed without the agent reading + wiring it in first.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { isWorkspaceSessionPrincipal } from '../../iam/agent-scope';
import { getCatalogEntry } from '../../marketplace/catalog';
import {
  buildRegistryWorkspaceInstallPrompt,
  buildTemplateInstallPrompt,
} from './marketplace-install-prompts';
import { auth, errors, json } from '../../openapi';
import { readManifestFromRepo } from '../git/files';
import { loadWorkspaceForUser } from '../lib/access';
import { AnyObject, workspaceRoutesApp } from '../lib/app';
import { loadGitWorkspace } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';

/** The workspace's manifest raw text, preferring kortix.yaml over kortix.toml
 *  (dual-format). */
async function manifestRawOrNull(
  workspace: Parameters<typeof readManifestFromRepo>[0],
): Promise<string | null> {
  const found = await readManifestFromRepo(
    workspace,
    manifestCandidatePaths(workspace.manifestPath).map((cand) => cand.path),
    workspace.defaultBranch,
  ).catch(() => null);
  return found?.content ?? null;
}

/** Agent-driven install of a skill/agent/command/tool into THIS workspace: the
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
    `Add the "${item.title ?? item.name}" ${typeLabel} to THIS workspace and set it up.`,
    '',
    item.description ?? '',
    '',
    'Steps:',
    `1. Fetch its source (marketplace item id "${id}") — read its files (SKILL.md / agent / tool definition) and place them into this workspace, following the workspace's existing conventions.`,
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

async function handleMarketplaceInstallSession(c: any) {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Flag gate AFTER membership authz. `marketplace` defaults ON platform-wide,
  // so this only rejects a project that explicitly turned it off.
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'marketplace');
  if (gate) return gate;

  const body = await readBody(c);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ error: 'id is required' }, 400);

  const entry = await getCatalogEntry(id);
  if (!entry) return c.json({ error: `Unknown item "${id}"` }, 400);

  const workspace = await loadGitWorkspace(loaded);
  let prompt: string;
  try {
    // Whole projects get merged (judgment-heavy, guards the target's kortix.yaml);
    // a use-case template renders inputs + wires its scheduled trigger; everything
    // else is a straight install + setup.
    if (entry.item.type === 'registry:project') {
      prompt = buildRegistryWorkspaceInstallPrompt(entry, await manifestRawOrNull(workspace));
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
    workspace: loaded.row,
    userId: loaded.userId,
    requestingPrincipalType: c.get('authType') === 'service_account' ? 'service_account' : 'human',
    body: {
      initial_prompt: prompt,
      name: `Add ${entry.item.title ?? entry.item.name}`,
      metadata: { kind: 'marketplace-install', item_id: id },
    },
    visibility: 'project',
    // Derive origin from the caller's token kind, same as POST /sessions (r7),
    // so a backend-driven install records origin='backend' rather than 'user'.
    authType: c.get('authType') as string | undefined,
    apiKeyType: c.get('apiKeyType') as string | undefined,
    inSession: isWorkspaceSessionPrincipal(c),
    request: requestAuditContext(c),
    queuePolicy: 'never',
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

  return c.json({ session_id: result.row.sessionId }, 201);
}

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/marketplace/install-session',
    tags: ['marketplace'],
    summary: 'POST /:workspaceId/marketplace/install-session',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Session started'),
      ...errors(400, 403, 404),
    },
  }),
  handleMarketplaceInstallSession,
);
