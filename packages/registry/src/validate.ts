/**
 * Lightweight structural validation for registry.json / registry-item.json.
 * Mirrors the ergonomics of `@kortix/manifest-schema` (a list of typed issues
 * with severities) so the CLI can render a consistent report.
 */

import { ALL_ITEM_TYPES, type RegistryItem, type RegistryJson, type RegistryItemType } from './schema';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// agentskills.io spec: lowercase a-z/0-9 with single hyphens, no leading/
// trailing/double hyphen. (Ingest stays lenient; this only warns on `validate`.)
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isRegistryItemType(value: unknown): value is RegistryItemType {
  return typeof value === 'string' && (ALL_ITEM_TYPES as readonly string[]).includes(value);
}

export function validateRegistryItem(item: unknown, basePath = 'item'): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (severity: ValidationIssue['severity'], path: string, message: string) =>
    issues.push({ severity, path, message });

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    push('error', basePath, 'item must be an object');
    return { valid: false, issues };
  }
  const it = item as Record<string, unknown>;

  if (typeof it.name !== 'string' || !it.name.trim()) {
    push('error', `${basePath}.name`, 'name is required');
  } else if (!SLUG_RE.test(it.name)) {
    push('warning', `${basePath}.name`, `"${it.name}" isn't a spec slug (lowercase a-z, 0-9, single hyphens)`);
  }

  if (!isRegistryItemType(it.type)) {
    push('error', `${basePath}.type`, `type must be one of: ${ALL_ITEM_TYPES.join(', ')}`);
  }

  const files = it.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      push('error', `${basePath}.files`, 'files must be an array');
    } else {
      files.forEach((f, i) => {
        const fp = `${basePath}.files[${i}]`;
        if (!f || typeof f !== 'object') {
          push('error', fp, 'file must be an object');
          return;
        }
        const file = f as Record<string, unknown>;
        const hasPath = typeof file.path === 'string' && file.path.trim().length > 0;
        const hasContent = typeof file.content === 'string';
        if (!hasPath && !hasContent) {
          push('error', `${fp}.path`, 'file needs a path or inline content');
        }
        if (file.type !== undefined && !isRegistryItemType(file.type)) {
          push('error', `${fp}.type`, 'file.type is not a valid registry type');
        }
        if (typeof file.target === 'string' && file.target.includes('..')) {
          push('error', `${fp}.target`, 'target may not contain ".." segments');
        }
      });
    }
  }

  // An item with no files and no dependencies installs nothing — unless it is a
  // bundle (whose whole job is to pull `registryDependencies`).
  const hasFiles = Array.isArray(files) && files.length > 0;
  const hasDeps = Array.isArray(it.registryDependencies) && it.registryDependencies.length > 0;
  if (!hasFiles && !hasDeps && it.type !== 'registry:bundle') {
    push('warning', basePath, 'item declares no files and no registryDependencies');
  }

  for (const key of ['dependencies', 'devDependencies', 'registryDependencies', 'categories']) {
    if (it[key] !== undefined && !Array.isArray(it[key])) {
      push('error', `${basePath}.${key}`, `${key} must be an array`);
    }
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

export function validateRegistry(registry: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (severity: ValidationIssue['severity'], path: string, message: string) =>
    issues.push({ severity, path, message });

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    push('error', 'registry', 'registry.json must be an object');
    return { valid: false, issues };
  }
  const reg = registry as Record<string, unknown>;

  if (typeof reg.name !== 'string' || !reg.name.trim()) {
    push('error', 'name', 'registry name is required');
  }

  const hasItems = Array.isArray(reg.items);
  const hasInclude = Array.isArray(reg.include);
  if (!hasItems && !hasInclude) {
    push('error', 'items', 'registry must declare `items` or `include`');
  }

  if (reg.include !== undefined && !Array.isArray(reg.include)) {
    push('error', 'include', 'include must be an array of paths');
  }

  const seen = new Set<string>();
  if (hasItems) {
    (reg.items as unknown[]).forEach((item, i) => {
      const res = validateRegistryItem(item, `items[${i}]`);
      issues.push(...res.issues);
      const name = (item as Record<string, unknown>)?.name;
      if (typeof name === 'string') {
        if (seen.has(name)) push('error', `items[${i}].name`, `duplicate item name "${name}"`);
        seen.add(name);
      }
    });
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `  ${i.severity === 'error' ? '✗' : '!'} ${i.path}: ${i.message}`)
    .join('\n');
}
