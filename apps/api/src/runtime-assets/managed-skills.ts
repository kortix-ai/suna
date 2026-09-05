/**
 * The managed `kortix-*` skill overlay, as data.
 *
 * ONE definition of "which files the overlay is made of", used by both places
 * that ship it:
 *
 *   • build time — `stageManagedSkills` (snapshots/build-context.ts) writes this
 *     exact set into the META image's `/opt/kortix/managed-skills`,
 *   • run time  — `GET /v1/runtime-assets/managed-skills` serves it to a live
 *     sandbox, which writes it to the same path and re-runs the daemon's
 *     `ensureInjectedManagedSkills` overlay.
 *
 * That second path is what closes the per-project gap: only the meta image ever
 * baked `/opt/kortix/managed-skills`, so an ordinary project sandbox had nothing
 * to overlay and its skills were whatever its repo happened to carry.
 *
 * The extraction deliberately matches the build-time one exactly — same
 * `getManagedSkillFiles()` + `getStarterFiles({ template:
 * 'general-knowledge-worker' })` sources, same `isKortixManagedSkillName` filter
 * — so a sandbox converges on the SAME bytes the image would have baked, not a
 * superset.
 */

import { createHash } from 'node:crypto';
import {
  getManagedSkillFiles,
  getStarterFiles,
  isKortixManagedSkillName,
} from '@kortix/starter';

/** Where skills live inside a Kortix project (and inside the starter templates). */
const SKILLS_PREFIX = '.kortix/opencode/skills/';

export interface ManagedSkillOverlayFile {
  /** Path relative to the overlay root, e.g. `kortix-system/SKILL.md`. */
  path: string;
  content: string;
}

/**
 * Every file of the managed-skill overlay, sorted by path so the byte stream —
 * and therefore the hash below — is deterministic across processes and deploys.
 */
export function managedSkillOverlayFiles(): ManagedSkillOverlayFile[] {
  const files = [
    ...getManagedSkillFiles(),
    ...getStarterFiles({ projectName: 'Kortix', template: 'general-knowledge-worker' }),
  ];
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith(SKILLS_PREFIX)) continue;
    const rest = file.path.slice(SKILLS_PREFIX.length);
    const name = rest.split('/')[0];
    if (!name || !isKortixManagedSkillName(name)) continue;
    // First writer wins, matching `stageManagedSkills`'s write order: the two
    // sources overlap on the managed names and the managed set is authoritative.
    if (!byPath.has(rest)) byPath.set(rest, file.content);
  }
  return [...byPath.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, content]) => ({ path, content }));
}

/**
 * Content hash of the overlay. This is the value a sandbox compares against its
 * own recorded hash to decide whether to re-download, so it must depend on the
 * file set AND on every byte in it — a renamed file with identical content must
 * still move the hash.
 */
export function managedSkillOverlayHash(files: ManagedSkillOverlayFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`file\0${file.path}\0${Buffer.byteLength(file.content)}\0`);
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
