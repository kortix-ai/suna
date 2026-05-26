/**
 * Kortix project starter — folder-based template.
 *
 * The starter is a shared base directory plus optional template layers.
 * `getStarterFiles()` walks the selected directories, applies `{{var}}`
 * substitutions, and returns `[{ path, content }]` so callers (the
 * API's create-repo flow, the `kortix init` CLI) can do whatever they
 * want with the result — commit to GitHub, write to disk, render a
 * preview.
 *
 * Editing the starter is plain file editing — shared Kortix runtime
 * files live under `templates/base/`, richer starter layers live under
 * `templates/<template>/`, and both the API and CLI pick them up.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface StarterFile {
  /** Repo-relative path (POSIX-separated, no leading slash). */
  path: string;
  /** UTF-8 content with `{{var}}` placeholders resolved. */
  content: string;
}

export const STARTER_TEMPLATE_IDS = ['minimal', 'general-knowledge-worker'] as const;
export type StarterTemplateId = (typeof STARTER_TEMPLATE_IDS)[number];
export const DEFAULT_STARTER_TEMPLATE_ID: StarterTemplateId = 'general-knowledge-worker';

export interface StarterTemplate {
  id: StarterTemplateId;
  name: string;
  description: string;
  includesGeneralKnowledgeWorkerSkills: boolean;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'general-knowledge-worker',
    name: 'General knowledge worker',
    description: 'Kortix system runtime plus the preconfigured general knowledge worker skill pack.',
    includesGeneralKnowledgeWorkerSkills: true,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Only the shared Kortix system runtime and default agent.',
    includesGeneralKnowledgeWorkerSkills: false,
  },
];

export interface StarterVars {
  /** Human display name for the project (e.g. "Company OS"). */
  projectName: string;
  /** "owner/repo" GitHub identifier. Optional — defaults to "your-org/your-repo". */
  repoFullName?: string;
  /** Starter variant. Defaults to the richer general knowledge worker. */
  template?: StarterTemplateId;
}

/** Absolute path to the bundled base template directory. */
export const BASE_TEMPLATE_DIR = join(import.meta.dir, '..', 'templates', 'base');
export const GENERAL_KNOWLEDGE_WORKER_TEMPLATE_DIR = join(
  import.meta.dir,
  '..',
  'templates',
  'general-knowledge-worker',
);

export function normalizeStarterTemplateId(value: unknown): StarterTemplateId {
  if (typeof value === 'string' && (STARTER_TEMPLATE_IDS as readonly string[]).includes(value)) {
    return value as StarterTemplateId;
  }
  return DEFAULT_STARTER_TEMPLATE_ID;
}

export function listGeneralKnowledgeWorkerSkills(): string[] {
  const skillsDir = join(
    GENERAL_KNOWLEDGE_WORKER_TEMPLATE_DIR,
    '.kortix',
    'opencode',
    'skills',
    'GENERAL-KNOWLEDGE-WORKER',
  );
  return readdirSync(skillsDir)
    .filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Walk the base template and return every file with `{{var}}`
 * placeholders resolved. Output is sorted by path for stable commit
 * ordering — both the API and CLI rely on that.
 */
export function getStarterFiles(vars: StarterVars): StarterFile[] {
  const resolvedVars: Required<StarterVars> = {
    projectName: vars.projectName,
    repoFullName: vars.repoFullName ?? 'your-org/your-repo',
    template: normalizeStarterTemplateId(vars.template),
  };

  const roots = [BASE_TEMPLATE_DIR];
  if (resolvedVars.template === 'general-knowledge-worker') {
    roots.push(GENERAL_KNOWLEDGE_WORKER_TEMPLATE_DIR);
  }

  const byPath = new Map<string, StarterFile>();
  for (const root of roots) {
    for (const absPath of walk(root)) {
      const rel = relative(root, absPath).split(sep).join('/');
      const raw = readFileSync(absPath, 'utf8');
      byPath.set(rel, { path: rel, content: interpolate(raw, resolvedVars) });
    }
  }

  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Replace `{{name}}` placeholders. Only `\w+` identifiers — keeps
 * accidental matches in code/docs (e.g. `{{ body.action }}` in a
 * trigger prompt) from being treated as substitution targets.
 */
function interpolate(input: string, vars: Required<StarterVars>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (name in vars) return (vars as Record<string, string>)[name]!;
    return match; // leave unknown placeholders intact
  });
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}
