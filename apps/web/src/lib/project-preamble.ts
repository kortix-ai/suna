import type { KortixProject } from '@/hooks/kortix/use-kortix-projects';

/**
 * Structured XML ref tags for every @-mention kind in the chat pipeline.
 *
 * Each block is a header line + one or more self-closing XML tags, appended
 * to the end of the outgoing message text. The agent sees structured
 * metadata, and the frontend strips every block back out of the rendered
 * bubble (see parse{Project,FileMention,AgentMention,Session}References in
 * session-chat.tsx).
 *
 * Shape is identical across kinds so the pattern stays uniform:
 *
 *   <user's text>
 *
 *   Referenced projects (...):
 *   <project_ref id="..." name="..." path="..." description="..." />
 *
 *   Referenced files (...):
 *   <file_ref path="..." name="..." />
 *
 *   Referenced agents (...):
 *   <agent_ref name="..." />
 *
 *   Referenced sessions (...):
 *   <session_ref id="..." title="..." />
 */

// ─── Attribute escaping ─────────────────────────────────────────────────────

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProjectRefLike {
  id?: string;
  name: string;
  path?: string;
  description?: string;
}

export interface FileRefLike {
  /** Path inside the workspace, e.g. `src/foo.ts` or absolute. */
  path: string;
  /** Display name — defaults to path. */
  name?: string;
}

export interface AgentRefLike {
  name: string;
}

export interface SessionRefLike {
  id: string;
  title: string;
}

// ─── Tag builders ───────────────────────────────────────────────────────────

export function buildProjectRef(p: ProjectRefLike): string {
  const attrs: string[] = [];
  if (p.id) attrs.push(`id="${escapeAttr(p.id)}"`);
  if (p.name) attrs.push(`name="${escapeAttr(p.name)}"`);
  if (p.path) attrs.push(`path="${escapeAttr(p.path)}"`);
  if (p.description) attrs.push(`description="${escapeAttr(p.description)}"`);
  return `<project_ref ${attrs.join(' ')} />`;
}

export function buildFileRef(f: FileRefLike): string {
  const name = f.name ?? f.path;
  return `<file_ref path="${escapeAttr(f.path)}" name="${escapeAttr(name)}" />`;
}

export function buildAgentRef(a: AgentRefLike): string {
  return `<agent_ref name="${escapeAttr(a.name)}" />`;
}

export function buildSessionRef(s: SessionRefLike): string {
  return `<session_ref id="${escapeAttr(s.id)}" title="${escapeAttr(s.title)}" />`;
}

// ─── Block builders ─────────────────────────────────────────────────────────

export function buildProjectRefsBlock(
  projects: ReadonlyArray<ProjectRefLike>,
): string {
  if (!projects.length) return '';
  const refs = projects.map(buildProjectRef).join('\n');
  return `Referenced projects (the user's active Kortix project context — treat the first one as "the project" unless told otherwise):\n${refs}`;
}

export function buildFileRefsBlock(
  files: ReadonlyArray<FileRefLike>,
): string {
  if (!files.length) return '';
  const refs = files.map(buildFileRef).join('\n');
  return `Referenced files (the user has explicitly @-mentioned these — read them if relevant):\n${refs}`;
}

export function buildAgentRefsBlock(
  agents: ReadonlyArray<AgentRefLike>,
): string {
  if (!agents.length) return '';
  const refs = agents.map(buildAgentRef).join('\n');
  return `Referenced agents (the user has @-mentioned these agents — delegate or hand off as appropriate):\n${refs}`;
}

// ─── Appenders (text-in, text-out) ──────────────────────────────────────────

export function appendProjectRefs(
  text: string,
  projects: ReadonlyArray<ProjectRefLike>,
): string {
  const block = buildProjectRefsBlock(projects);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

export function appendFileRefs(
  text: string,
  files: ReadonlyArray<FileRefLike>,
): string {
  const block = buildFileRefsBlock(files);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

export function appendAgentRefs(
  text: string,
  agents: ReadonlyArray<AgentRefLike>,
): string {
  const block = buildAgentRefsBlock(agents);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

/**
 * Convenience: append a single KortixProject's ref to text. Used by the
 * dashboard + session empty-state ProjectSelector flow.
 */
export function appendProjectRef(
  text: string,
  project: KortixProject | null | undefined,
): string {
  if (!project) return text;
  return appendProjectRefs(text, [
    {
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description,
    },
  ]);
}
