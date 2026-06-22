import * as MynaIcons from '@mynaui/icons-react';
import type { Icon as MynauiIcon } from '@mynaui/icons-react';
import { buildKebabAliasMap, toKebabCase, FORCE_SOLID } from '@/lib/icon-migration-map';

/**
 * Runtime registry of mynaui icons keyed by kebab-case name, used for
 * string-driven ("dynamic") icons whose name is chosen at runtime (e.g. a
 * thread or agent icon stored in the DB). Default is the regular (outline)
 * variant; bases in FORCE_SOLID render filled. Solid is also used as a fallback
 * for the rare icon that has no outline variant.
 */
export const mynauiIconRegistry: Record<string, MynauiIcon> = (() => {
  const registry: Record<string, MynauiIcon> = {};
  for (const [name, value] of Object.entries(MynaIcons)) {
    // mynaui icons are forwardRef components (objects with `$$typeof`); the
    // `create*Component` factories are plain functions — skip those.
    const isComponent =
      (typeof value === 'object' && value !== null && '$$typeof' in value) ||
      (typeof value === 'function' && !name.startsWith('create'));
    if (!isComponent) continue;
    const isSolid = name.endsWith('Solid');
    const base = isSolid ? name.slice(0, -'Solid'.length) : name;
    const key = toKebabCase(base);
    if (FORCE_SOLID.has(base)) {
      // Pinned to filled — the Solid variant wins; outline is only a fallback.
      if (isSolid || !registry[key]) registry[key] = value as MynauiIcon;
    } else if (!isSolid || !registry[key]) {
      // Regular default — the outline variant wins; Solid is only a fallback.
      registry[key] = value as MynauiIcon;
    }
  }
  return registry;
})();

/** lucide kebab name -> mynaui kebab name, so previously-stored lucide icon names still resolve. */
const LUCIDE_KEBAB_ALIAS = buildKebabAliasMap();

/** Normalize any PascalCase or kebab-case input to a single kebab-case form. */
function toCanonicalKebab(name: string): string {
  return name.includes('-') ? name.toLowerCase() : toKebabCase(name);
}

/**
 * Resolve an icon name (PascalCase or kebab-case, lucide- or mynaui-vocabulary)
 * to the kebab-case key that exists in {@link mynauiIconRegistry}, or null.
 */
export function resolveIconKey(iconName: string | null | undefined): string | null {
  if (!iconName || typeof iconName !== 'string') return null;
  const canonical = toCanonicalKebab(iconName);
  if (mynauiIconRegistry[canonical]) return canonical;
  const aliased = LUCIDE_KEBAB_ALIAS[canonical];
  if (aliased && mynauiIconRegistry[aliased]) return aliased;
  return null;
}

/** Validates if an icon name maps to a known mynaui icon (kebab- or PascalCase). */
export function isValidIconName(iconName: string | null | undefined): boolean {
  return resolveIconKey(iconName) !== null;
}

/**
 * Normalizes an icon name to the kebab-case key understood by DynamicIcon, or
 * null if the icon doesn't exist. Returns the mynaui kebab name (lucide names
 * are translated through the migration alias map).
 */
export function normalizeIconName(iconName: string | null | undefined): string | null {
  return resolveIconKey(iconName);
}
