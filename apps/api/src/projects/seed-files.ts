import { type StarterTemplateId } from '@kortix/starter';
import { parseManifestText } from '@kortix/manifest-schema';
import { buildStarterFiles } from './starter';

export interface ProjectSeedFilesInput {
  projectName: string;
  repoFullName: string;
  template: StarterTemplateId;
  now: string;
}

/**
 * Seed a brand-new project's deterministic scaffold: just the starter's own
 * runtime files (kortix.yaml, opencode config, base skills) for `template`.
 * No lock, no dependency engine.
 */
export async function buildProjectSeedFiles(input: ProjectSeedFilesInput): Promise<{
  files: Array<{ path: string; content: string }>;
  baseFiles: Array<{ path: string; content: string }>;
}> {
  const baseFiles = buildStarterFiles({
    projectName: 'kortix-project',
    repoFullName: 'kortix/kortix-project',
    template: input.template,
  });
  const files = buildStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: input.template,
  });

  return { files, baseFiles };
}

/**
 * Best-effort extraction of a seeded `kortix.yaml`'s top-level `default_agent`
 * from a file list POST /projects/provision is about to push. Used to stamp
 * `project.metadata.default_agent` (the read-optimized mirror session creation
 * and the LLM gateway's model-default resolution consult — see
 * projects/lib/sessions.ts and llm-gateway/resolution/default-model.ts) at
 * project-creation time, the same value `PUT /:projectId/default-agent`
 * writes later. Without this, a brand-new project's manifest declares a
 * default agent (the starter template ships `default_agent: kortix`) that the
 * DB mirror never learns about — every session then stores the non-binding
 * `'default'` sentinel instead, and any agent-scope model pin set on the real
 * agent name is silently never applied (the bug this closes).
 *
 * Never throws: a parse failure here must not fail project creation —
 * session creation's own manifest read (for MANDATORY DECLARED AGENTS
 * projects) is the actual source of truth and will surface a real error if
 * the manifest is genuinely broken.
 */
export function defaultAgentFromSeedFiles(
  files: Array<{ path: string; content: string }>,
  manifestPath: string,
): string | null {
  const manifestFile = files.find((f) => f.path === manifestPath) ?? files.find((f) => f.path === 'kortix.yaml');
  if (!manifestFile) return null;
  try {
    const raw = parseManifestText(manifestFile.content, 'yaml');
    const defaultAgent = raw.default_agent;
    return typeof defaultAgent === 'string' && defaultAgent.trim() ? defaultAgent.trim() : null;
  } catch {
    return null;
  }
}
