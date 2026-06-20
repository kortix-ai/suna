/**
 * Skills API — CRUD operations for SKILL.md files.
 *
 * - List: uses `client.app.skills()` (GET /skill)
 * - Create/Update: writes SKILL.md via kortix-master /file/upload
 * - Delete: removes the skill directory via kortix-master DELETE /file
 *
 * Skills are created in .opencode/skills/<name>/SKILL.md (project-relative).
 * After any mutation, `instance.dispose()` is called to force the OpenCode
 * server to rescan skill directories (the skill list is cached at startup).
 */

import { getClient } from '@/lib/opencode-sdk';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import type {
  Skill,
  CreateSkillInput,
  UpdateSkillInput,
} from '../types';
import { buildSkillFileContent } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Project-relative path where skills are stored */
const SKILLS_DIR = '.opencode/skills';

// ---------------------------------------------------------------------------
// Helper: unwrap SDK response
// ---------------------------------------------------------------------------

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as any;
    throw new Error(err?.data?.message || err?.message || 'SDK request failed');
  }
  return result.data as T;
}

// ---------------------------------------------------------------------------
// Helper: refresh skill list
// ---------------------------------------------------------------------------

/**
 * Force the OpenCode server to rescan skill directories.
 *
 * The server caches the skill list at startup. After creating, updating,
 * or deleting a skill file we need to dispose the current instance so
 * the server re-discovers skills on the next request.
 */
async function refreshSkills(): Promise<void> {
  const client = getClient();
  await client.instance.dispose();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List all available skills from the OpenCode server.
 */
export async function listSkills(): Promise<Skill[]> {
  const client = getClient();
  const result = await client.app.skills();
  return unwrap(result) as Skill[];
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Upload content to a specific file path (project-relative).
 *
 * Uses the FormData field-name-as-path convention (same as the files feature).
 * Posts directly to kortix-master's /file/upload endpoint.
 */
async function uploadToPath(
  filePath: string,
  content: string,
): Promise<void> {
  const baseUrl = getActiveOpenCodeUrl();
  if (!baseUrl) {
    throw new Error('No OpenCode server URL configured');
  }

  const blob = new Blob([content], { type: 'text/markdown' });
  const form = new FormData();
  const fileName = filePath.split('/').pop() || 'SKILL.md';
  form.append(filePath, blob, fileName);

  const res = await authenticatedFetch(`${baseUrl}/file/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to write skill file (${res.status}): ${text || res.statusText}`);
  }
}

/**
 * Convert an absolute skill location to a project-relative path.
 *
 * Skills returned by `client.app.skills()` have absolute `location` paths.
 * To edit/delete them via the file API we need the project-relative portion.
 * We extract everything from `.opencode/skills/` onwards.
 */
function toRelativePath(absoluteLocation: string): string {
  // Match .opencode/skills/... portion
  const marker = '.opencode/skills/';
  const idx = absoluteLocation.indexOf(marker);
  if (idx !== -1) {
    return absoluteLocation.slice(idx);
  }
  // Fallback: try other known skill directory patterns
  for (const pattern of ['.claude/skills/', '.agents/skills/']) {
    const i = absoluteLocation.indexOf(pattern);
    if (i !== -1) return absoluteLocation.slice(i);
  }
  // Last resort: return as-is (may not work but lets the server decide)
  return absoluteLocation;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new skill in the project's .opencode/skills/ directory.
 */
export async function createSkill(input: CreateSkillInput): Promise<void> {
  const skillDir = `${SKILLS_DIR}/${input.name}`;

  // Ensure the skill directory exists
  const baseUrl = getActiveOpenCodeUrl();
  const mkdirRes = await authenticatedFetch(`${baseUrl}/file/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: skillDir }),
  });
  if (!mkdirRes.ok) {
    const text = await mkdirRes.text().catch(() => '');
    throw new Error(`Failed to create skill directory (${mkdirRes.status}): ${text || mkdirRes.statusText}`);
  }

  // Write the SKILL.md file
  const filePath = `${skillDir}/SKILL.md`;
  const content = buildSkillFileContent(input.name, input.description, input.body);
  await uploadToPath(filePath, content);

  // Force the server to rescan skills so the new one appears in the list
  await refreshSkills();
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update an existing skill's content.
 *
 * Overwrites the SKILL.md file at the given location. The name cannot
 * be changed (it's tied to the directory name).
 */
export async function updateSkill(
  name: string,
  input: UpdateSkillInput,
): Promise<void> {
  const relativePath = toRelativePath(input.location);
  const content = buildSkillFileContent(name, input.description, input.body);
  await uploadToPath(relativePath, content);

  // Force rescan so the updated content is reflected
  await refreshSkills();
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a skill by removing its entire directory.
 *
 * The location points to the SKILL.md file — we delete the parent directory.
 */
export async function deleteSkill(location: string): Promise<void> {
  const relativePath = toRelativePath(location);
  // Remove the /SKILL.md suffix to get the directory
  const skillDir = relativePath.replace(/\/SKILL\.md$/, '');
  const baseUrl = getActiveOpenCodeUrl();
  const res = await authenticatedFetch(`${baseUrl}/file`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: skillDir }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to delete skill (${res.status}): ${text || res.statusText}`);
  }

  // Force rescan so the deleted skill is removed from the list
  await refreshSkills();
}
