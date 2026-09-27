/**
 * Pure logic behind the project tool renderers
 * (`components/session/tool/tools/project-*-tool.tsx`).
 *
 * Triggers are ported from apps/web `tool/tools/project-*-tool.tsx` with the
 * English copy from `apps/web/translations/en.json`. `projectOpenTarget` is
 * mobile's replacement for web's "open the workspace tab": a completed
 * `project_select` / `project_create` row opens that project's page.
 */

import { parseProjectCreateOutput, parseProjectSelectOutput } from './projects-tool-output';

export interface ProjectTrigger {
  title: string;
  subtitle?: string;
  args?: string[];
}

/** `hardcodedUi.i18nComplete.text87bb59ba2f92`. */
const WORKSPACE = 'Workspace';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function projectCreateTrigger(
  input: Record<string, unknown>,
  output: string,
  errored: boolean,
): ProjectTrigger {
  const displayName = parseProjectCreateOutput(output || '')?.name || str(input.name);
  return { title: WORKSPACE, subtitle: errored ? displayName || 'failed' : displayName };
}

export function projectSelectTrigger(
  input: Record<string, unknown>,
  output: string,
  errored: boolean,
): ProjectTrigger {
  const name = parseProjectSelectOutput(output || '')?.name || str(input.project);
  if (errored) return { title: WORKSPACE, subtitle: name || 'failed' };
  return { title: 'Workspace Active', subtitle: name };
}

export function projectGetTrigger(input: Record<string, unknown>): ProjectTrigger {
  return { title: 'Workspace Details', subtitle: str(input.name) || 'Fetching...' };
}

/** `project_list`: "global workspace" once a project parsed. */
export function projectListSubtitle(count: number): string | undefined {
  return count > 0 ? 'global workspace' : undefined;
}

export function projectDeleteTrigger(input: Record<string, unknown>): ProjectTrigger {
  const project = str(input.project);
  return {
    title: WORKSPACE,
    subtitle: 'Workspace delete disabled',
    args: project ? [project] : undefined,
  };
}

/**
 * The project a completed `project_select` / `project_create` row opens:
 * the first `proj-…` id in the output, else the input name / project. The
 * title is the name the row shows (parsed name, else the input).
 */
export function projectOpenTarget(
  tool: string,
  status: string,
  input: Record<string, unknown>,
  output: string,
): { projectId: string; displayName: string } | null {
  const normalized = tool.replace(/^oc-/, '').replace(/-/g, '_');
  if (normalized !== 'project_select' && normalized !== 'project_create') return null;
  if (status !== 'completed') return null;
  const idMatch = output.match(/proj-[a-z0-9-]+/);
  const projectId = idMatch ? idMatch[0] : str(input.name) || str(input.project);
  if (!projectId) return null;
  const displayName =
    normalized === 'project_select'
      ? parseProjectSelectOutput(output)?.name || str(input.project)
      : parseProjectCreateOutput(output)?.name || str(input.name);
  return { projectId, displayName: displayName || projectId };
}
