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
 * superset. `getMarketplaceFiles()` is intentionally absent (see
 * skills/catalog.ts, which does include it: that surface answers "read any
 * managed skill", this one answers "what does the overlay contain").
 */

import { createHash } from 'node:crypto';
import { SKILLS_DIR } from '@kortix/manifest-schema';
import {
  getManagedSkillFiles,
  getStarterFiles,
  isKortixManagedSkillName,
} from '@kortix/starter';

/**
 * Every flag a skill template wraps in `<!-- flag:NAME -->` blocks. The overlay
 * has one variant per subset of these. A unit test pins this list to the
 * markers actually present in `packages/starter/templates`.
 */
export const OVERLAY_FLAGS = ['human_messaging'] as const;

/** Where skills live inside the starter templates (and a root-layout Kortix project). */
const SKILLS_PREFIX = `${SKILLS_DIR}/`;

export interface ManagedSkillOverlayFile {
  /** Path relative to the overlay root, e.g. `kortix-system/SKILL.md`. */
  path: string;
  content: string;
}

/**
 * Every file of the managed-skill overlay, sorted by path so the byte stream —
 * and therefore the hash below — is deterministic across processes and deploys.
 */
export function managedSkillOverlayFiles(flags: readonly string[] = []): ManagedSkillOverlayFile[] {
  const files = [
    ...getManagedSkillFiles({ flags }),
    ...getStarterFiles({ projectName: 'Kortix', template: 'general-knowledge-worker', flags }),
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

const overlayCache = new Map<string, { files: ManagedSkillOverlayFile[]; hash: string }>();

/**
 * Overlay files + hash for one set of ON flags. Memoized per sorted flag list:
 * the templates are immutable for the life of a process.
 */
export function managedSkillOverlayFor(flags: readonly string[] = []): {
  files: ManagedSkillOverlayFile[];
  hash: string;
} {
  const on = OVERLAY_FLAGS.filter((f) => flags.includes(f));
  const key = on.join(',');
  let hit = overlayCache.get(key);
  if (!hit) {
    const files = managedSkillOverlayFiles(on);
    hit = { files, hash: managedSkillOverlayHash(files) };
    overlayCache.set(key, hit);
  }
  return hit;
}

/**
 * Server-side convergence compares a box's running overlay hash with ONE
 * desired hash (flags off). A box whose project turned a flag on legitimately
 * runs another variant. Map any variant's hash to the flags-off hash so those
 * compares read "current". The box itself reconciles flag changes against the
 * per-session `/manifest`; a flag toggle is not drift the server must chase.
 */
export function normalizeRunningSkillsHash<T extends string | null>(have: T): T | string {
  if (!have) return have;
  const base = managedSkillOverlayFor([]).hash;
  for (let mask = 1; mask < 1 << OVERLAY_FLAGS.length; mask++) {
    const on = OVERLAY_FLAGS.filter((_, i) => mask & (1 << i));
    if (managedSkillOverlayFor(on).hash === have) return base;
  }
  return have;
}
