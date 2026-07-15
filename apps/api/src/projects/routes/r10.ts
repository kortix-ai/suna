/**
 * Marketplace install — project-scoped, agent-driven.
 *
 *   POST /:projectId/marketplace/install-session { id } → start a session that
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
import { getCatalogEntry } from '../../marketplace/catalog';
import { buildTemplateInstallPrompt } from './marketplace-install-prompts';
import { auth, errors, json } from '../../openapi';
import { readManifestFromRepo } from '../git/files';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { createProjectSession, sendSessionCreateError } from '../lib/sessions';

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

/** Build the initial prompt for an agent-driven merge of a `registry:project`
 *  item into an EXISTING project. This is judgment-heavy (does the incoming
 *  agent persona collide with one that already exists? does the target project
 *  even want a new default agent?) — so an agent reads both sides and opens
 *  a change request rather than a blind file overwrite. */
function buildRegistryProjectInstallPrompt(
  entry: NonNullable<Awaited<ReturnType<typeof getCatalogEntry>>>,
  targetManifestRaw: string | null,
): string {
  const item = entry.item;
  const ownFiles = (item.files ?? []).filter((f) => typeof f.content === 'string');
  // Today every registry:project item is a base (inline-content) item, so
  // `files[].content` is always populated here. If an EXTERNAL project item
  // ever lands in the catalog, its file content is fetched lazily and isn't
  // present on `item.files` — silently falling through would produce a prompt
  // with none of the template's actual files, i.e. a no-op merge. Fail loudly
  // instead of degrading silently (a full fix would resolve content via
  // `getCatalogItemFile` per file).
  if ((item.files ?? []).length > 0 && ownFiles.length === 0) {
    throw new Error(
      `Project template "${item.name}" has no resolvable file content (likely an external registry item) — install-session merge only supports base project items today.`,
    );
  }
  const deps = item.registryDependencies ?? [];

  const lines: string[] = [
    `Integrate the "${item.title ?? item.name}" project template into THIS project — without breaking anything already here.`,
    '',
    item.description ?? '',
    '',
    "This project's current kortix.yaml:",
    '```yaml',
    targetManifestRaw ?? '(no manifest found)',
    '```',
    '',
    'The template contributes these files. Its own kortix.yaml is a reference for what agent it expects to exist — do NOT overwrite this project\'s kortix.yaml with it verbatim.',
  ];
  for (const file of ownFiles) {
    lines.push('', `--- ${file.path} ---`, '```', file.content ?? '', '```');
  }
  if (deps.length > 0) {
    lines.push(
      '',
      "It also depends on these marketplace skills — install each one (they're additive, they won't conflict with anything already installed):",
      ...deps.map((d) => `- ${d}`),
    );
  }
  lines.push(
    '',
    'Steps:',
    "1. Read this project's current kortix.yaml and .kortix/opencode/agents/ to see what already exists.",
    '2. Add the template\'s agent persona as a new agent file — rename it if the name collides with an existing agent. Do not remove or overwrite any existing agent.',
    "3. Merge the template's kortix.yaml `agents:` entry for that agent into this project's kortix.yaml. Leave default_agent and every other existing agent untouched unless the user asks otherwise.",
    '4. Install the marketplace skills listed above.',
    '5. Open a change request with the result — do not push directly to the default branch.',
  );
  return lines.join('\n');
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
  const meta = (item.meta ?? {}) as { capabilities?: { connectors?: string[]; secrets?: string[] } };
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

async function handleMarketplaceInstallSession(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ error: 'id is required' }, 400);

  const entry = await getCatalogEntry(id);
  if (!entry) return c.json({ error: `Unknown item "${id}"` }, 400);

  const project = await loadGitProject(loaded);
  let prompt: string;
  try {
    // Whole projects get merged (judgment-heavy, guards the target's kortix.yaml);
    // a use-case template renders inputs + wires its scheduled trigger; everything
    // else is a straight install + setup.
    prompt =
      entry.item.type === 'registry:project'
        ? buildRegistryProjectInstallPrompt(entry, await manifestRawOrNull(project))
        : entry.item.type === 'registry:template'
          ? buildTemplateInstallPrompt(entry, id)
          : buildItemInstallPrompt(entry, id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const result = await createProjectSession({
    project: loaded.row,
    userId: loaded.userId,
    body: {
      initial_prompt: prompt,
      name: `Add ${entry.item.title ?? entry.item.name}`,
      metadata: { kind: 'marketplace-install', item_id: id },
    },
    visibility: 'project',
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);

  return c.json({ session_id: result.row!.sessionId }, 201);
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/install-session',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/install-session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Session started'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceInstallSession,
);
