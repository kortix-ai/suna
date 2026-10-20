import { skillDirs } from '@kortix/manifest-schema';
import type { ParsedManifest } from '../triggers';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safePath = (path: string) => !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');

/** Resolve the catalog identity, never construct a deletion path from request text. */
export function prepareSkillDeletion(
  name: string,
  skills: Array<{ name: string; path: string }>,
  files: Array<{ path: string }>,
  manifest: ParsedManifest,
): { ok: true; deletes: string[]; raw: Record<string, unknown> } | { ok: false; status: 404 | 409; error: string } {
  const matches = skills.filter(skill => skill.name === name);
  if (!matches.length) return { ok: false, status: 404, error: 'Skill not found' };
  const conflict = { ok: false as const, status: 409 as const, error: 'Skill has an unsafe or shared folder' };
  if (matches.length !== 1) return conflict;
  const match = matches[0];
  if (!match) return conflict;
  const path = match.path;
  if (!safePath(path) || !path.endsWith('/SKILL.md')) return conflict;
  const folder = path.slice(0, -'/SKILL.md'.length);
  // Never delete an entire resource root, even if its SKILL.md was registered.
  if (!folder.includes('/')) return conflict;
  const inside = (value: string) => value === folder || value.startsWith(`${folder}/`);
  const registry = record(manifest.raw.skills);
  const roots = skillDirs(manifest.raw);
  const root = roots.find(root => folder.startsWith(`${root}/`));
  const legacySlug = root ? folder.slice(root.length + 1) : null;
  if (manifest.schemaVersion < 3 && (!legacySlug || roots.some(other => other !== root
    && files.some(file => file.path === `${other}/${legacySlug}/SKILL.md`)))) return conflict;
  const grantIdentity = manifest.schemaVersion >= 3 ? name : legacySlug;

  if (skills.some(skill => skill !== matches[0] && (inside(skill.path) || folder.startsWith(`${skill.path.slice(0, -'/SKILL.md'.length)}/`)))) return conflict;
  if (Object.entries(registry).some(([key, value]) => key !== name && typeof value === 'string'
    && (inside(value) || folder.startsWith(`${value}/`)))) return conflict;
  const protectedPaths = [manifest.path, ...(manifest.candidatePaths ?? []),
    ...Object.values(record(manifest.raw.agents)).flatMap(value => {
      const agent = record(value);
      return [agent.file, agent.prompt_file].filter((path): path is string => typeof path === 'string');
    }),
    ...Object.values(record(manifest.raw.commands)).flatMap(value => {
      const path = record(value).prompt_file;
      return typeof path === 'string' ? [path] : [];
    }),
  ];
  // Imports may contain additional configuration paths. Refuse this uncommon
  // layout until all imported resource references can be proven disjoint.
  if (manifest.imports || protectedPaths.some(inside)) return conflict;
  const deletes = files.filter(file => inside(file.path)).map(file => file.path);
  if (deletes.some(path => !safePath(path))) return conflict;
  if (deletes.length && !deletes.includes(path)) return conflict;
  const raw = structuredClone(manifest.raw);
  if (Object.hasOwn(registry, name)) delete record(raw.skills)[name];
  for (const agent of Object.values(record(raw.agents))) {
    const block = record(agent);
    if (Array.isArray(block.skills)) block.skills = block.skills.filter(skill => skill !== grantIdentity && skill !== name);
  }
  // Registry-only v3 entries can still be removed when their folder is absent.
  if (!deletes.length && !Object.hasOwn(registry, name)) return { ok: false, status: 404, error: 'Skill not found' };
  return { ok: true, deletes, raw };
}
