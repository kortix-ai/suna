/**
 * Create-project form rules, shared by `NewProjectSheet` (the switcher's `+`
 * and the Projects page) and the full-screen `/new` (COR-161). Pure, tested
 * in new-project-form.test.ts.
 */

import { creatableAccounts } from '@/lib/projects/landing';
import type { KortixAccount } from '@/lib/projects/projects-client';

/** Mirrors the API's PROJECT_NAME_MAX_LENGTH (projects.name is varchar(255)). */
export const PROJECT_NAME_MAX_LENGTH = 120;

export type ProjectNameResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Drops every character the API rejects (letters, digits, `.`, `_`, space
 * and `-` pass), trims, then checks presence and length.
 */
export function validateProjectName(raw: string): ProjectNameResult {
  const name = raw.replace(/[^a-zA-Z0-9._ -]+/g, '').trim();
  if (!name) return { ok: false, error: 'Project name is required' };
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return { ok: false, error: `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, name };
}

/**
 * The account a project is created in: the user's pick, else `preferred`
 * when a project can be created there, else the first account the user owns
 * or administers. Null when there is none.
 */
export function resolveCreateAccountId(input: {
  accounts: KortixAccount[];
  picked: string | null;
  preferred: string | null;
}): string | null {
  const creatable = creatableAccounts(input.accounts);
  if (input.picked && creatable.some((a) => a.account_id === input.picked)) return input.picked;
  if (creatable.some((a) => a.account_id === input.preferred)) return input.preferred;
  return creatable[0]?.account_id ?? null;
}

/**
 * The account picker shows only when the user can create in two or more
 * accounts — web's `AccountPicker` rule (`features/workspace/new`): one
 * account is not a decision.
 */
export function showAccountPicker(accounts: KortixAccount[]): boolean {
  return creatableAccounts(accounts).length > 1;
}

/**
 * Starter prompts on `/new`: a pick names the project (when the name field
 * is empty or still holds another starter's name) and becomes the first
 * message's draft on project home.
 */
export interface ProjectStarter {
  id: 'research' | 'website' | 'analysis';
  label: string;
  name: string;
  prompt: string;
}

export const PROJECT_STARTERS: ProjectStarter[] = [
  {
    id: 'research',
    label: 'Research a topic',
    name: 'Research',
    prompt: 'Research the latest developments in my industry and write a one-page brief with sources.',
  },
  {
    id: 'website',
    label: 'Build a website',
    name: 'Website',
    prompt: 'Build a simple landing page for my product and show me a preview.',
  },
  {
    id: 'analysis',
    label: 'Analyze data',
    name: 'Analysis',
    prompt: 'Analyze the spreadsheet I attach and summarize the key trends with a chart.',
  },
];

/**
 * The name field after a starter tap. A name the user typed is kept; an
 * empty field or another starter's name becomes the picked starter's name.
 * Unpicking (`next` null) clears a starter's name and keeps a typed one.
 */
export function nameAfterStarterPick(currentName: string, next: ProjectStarter | null): string {
  const trimmed = currentName.trim();
  const isStarterName = trimmed === '' || PROJECT_STARTERS.some((s) => s.name === trimmed);
  if (!isStarterName) return currentName;
  return next ? next.name : '';
}
