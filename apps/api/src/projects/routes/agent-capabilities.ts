// GET /v1/projects/:projectId/agents/:agentName/capabilities: every tool,
// skill and extension a session of the agent can have, with its description
// (`../lib/agent-capabilities.ts`). The agent page draws its switches from
// it; the agent's grants in kortix.yaml decide which ones are on.

import { createRoute, z } from '@hono/zod-openapi';
import { parseFrontmatter } from '@kortix/registry';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json } from '../../openapi';
import { listManagedSkills } from '../../skills/catalog';
import { agentNotDeclaredError } from '../agents';
import { readRepoFile } from '../git';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { buildAgentCapabilities } from '../lib/agent-capabilities';
import { projectsApp } from '../lib/app';
import { projectBuiltinAgents } from '../lib/builtin-agents';
import { featureFlagsEnvValue } from '../lib/feature-flag-env';
import { withProjectGitAuth } from '../lib/git';
import { enabledBuiltinAgentKey } from '../lib/platform-meta-agent';
import { readManifest } from '../triggers';

const ToolSchema = z.object({
  id: z.string(),
  group: z.enum(['workspace', 'interaction', 'kortix', 'project']),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  source: z.string().nullable(),
});
const SkillSchema = z.object({
  id: z.string(),
  group: z.enum(['builtin', 'project']),
  description: z.string().nullable(),
  feature_flag: z.string().nullable(),
  available: z.boolean(),
});
const ExtensionSchema = z.object({
  id: z.string(),
  group: z.enum(['platform', 'project']),
  description: z.string().nullable(),
  required: z.boolean(),
  controlled_by: z.string().nullable(),
});
const CapabilitiesSchema = z.object({
  agent: z.string(),
  schema_version: z.number(),
  tools: z.array(ToolSchema),
  skills: z.array(SkillSchema),
  extensions: z.array(ExtensionSchema),
});

const ProjectCapabilitiesSchema = CapabilitiesSchema.omit({ agent: true });

/** The project's catalog: every tool, skill and extension any of its agents can be given. */
async function projectCatalog(c: Parameters<typeof loadProjectForUser>[0], projectId: string, agentName: string | null) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { error: { body: { error: 'Not found' }, status: 404 as const } };
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_AGENT_READ);

  const gitProject = await withProjectGitAuth(loaded.row);
  const manifest = await readManifest(gitProject).catch(() => null);
  if (!manifest) {
    return { error: { body: { error: 'The project has no readable kortix.yaml.', code: 'manifest_read' }, status: 400 as const } };
  }
  if (agentName !== null) {
    const builtin = enabledBuiltinAgentKey(agentName, projectBuiltinAgents(manifest.raw, loaded.row.metadata));
    const notDeclared = builtin ? null : agentNotDeclaredError(manifest, agentName);
    if (notDeclared) return { error: { body: notDeclared, status: 404 as const } };
  }

  const registered = manifest.raw.skills;
  const folders = registered && typeof registered === 'object' && !Array.isArray(registered) ? Object.entries(registered) : [];
  const projectSkillDescriptions = Object.fromEntries(
    await Promise.all(
      folders.map(async ([name, folder]) => {
        const text = await readRepoFile(gitProject, `${String(folder)}/SKILL.md`, loaded.row.defaultBranch).catch(() => null);
        return [name, text ? (parseFrontmatter(text).description ?? null) : null] as const;
      }),
    ),
  );
  return {
    catalog: buildAgentCapabilities({
      agentName: agentName ?? '',
      manifest: manifest.raw,
      schemaVersion: manifest.schemaVersion,
      managedSkills: listManagedSkills(),
      projectSkillDescriptions,
      enabledFlags: new Set(featureFlagsEnvValue(loaded.row.metadata).split(',')),
    }),
  };
}

export function registerAgentCapabilitiesRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/capabilities',
      tags: ['projects'],
      summary: "List the project's tools, skills and extensions",
      description:
        'Every tool, skill and extension an agent of this project can be given: the built-in ones (with the feature flag a skill needs) and the ones kortix.yaml registers.',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(ProjectCapabilitiesSchema, 'The project capability catalog'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const out = await projectCatalog(c, projectId, null);
      if ('error' in out && out.error) return c.json(out.error.body, out.error.status);
      const { agent: _agent, ...catalog } = out.catalog!;
      return c.json(catalog, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/agents/{agentName}/capabilities',
      tags: ['projects'],
      summary: "List an agent's tools, skills and extensions",
      ...auth,
      request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
      responses: { 200: json(CapabilitiesSchema, 'The agent capability catalog'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { projectId, agentName } = c.req.valid('param');
      const out = await projectCatalog(c, projectId, agentName);
      if ('error' in out && out.error) return c.json(out.error.body, out.error.status);
      return c.json(out.catalog!, 200);
    },
  );
}
