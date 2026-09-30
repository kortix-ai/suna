/** Local wiring checks that require files and cannot live in the portable manifest schema. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ManifestIssue, RESERVED_SLUG_PROVIDERS } from '@kortix/manifest-schema';
import { agentFileCandidates, skillDirs } from '@kortix/manifest-schema/layout';

export function lintWiring(manifest: Record<string, unknown> | null, root: string): ManifestIssue[] {
  if (!manifest || manifest.kortix_version !== 2) return [];
  const issues: ManifestIssue[] = [];
  const agents = manifest.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return issues;
  const env = manifest.env as { required?: string[]; optional?: string[] } | undefined;
  const secrets = new Set([...(env?.required ?? []), ...(env?.optional ?? [])]);
  const connectors = new Set([
    ...Object.keys(RESERVED_SLUG_PROVIDERS),
    ...(Array.isArray(manifest.connectors) ? manifest.connectors : [])
      .map((entry: { slug?: string }) => entry?.slug)
      .filter((slug): slug is string => typeof slug === 'string'),
  ]);
  const missing = (path: string, name: string, source: string) =>
    issues.push({ path, message: `"${name}" is not declared in ${source}.`, severity: 'error' });
  for (const [name, value] of Object.entries(agents)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const agent = value as Record<string, unknown>;
    if (!agentFileCandidates(manifest, name).some((path) => existsSync(resolve(root, path)))) {
      missing(`agents.${name}.file`, String(agent.file ?? `agents/${name}.md`), 'the project files');
    }
    for (const [field, catalog, source] of [
      ['connectors', connectors, 'connectors'],
      ['connectors_required', connectors, 'connectors'],
      ['secrets', secrets, 'env.required or env.optional'],
    ] as const) {
      const list = agent[field];
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        if (typeof item === 'string' && item !== '*' && !catalog.has(item))
          missing(`agents.${name}.${field}[${index}]`, item, source);
      });
    }
    if (Array.isArray(agent.skills)) agent.skills.forEach((item, index) => {
      if (typeof item !== 'string' || item === '*' || !/^[a-zA-Z0-9_-]+$/.test(item)) return;
      if (!skillDirs(manifest).some((dir) => existsSync(resolve(root, dir, item, 'SKILL.md'))))
        missing(`agents.${name}.skills[${index}]`, item, 'skills/<name>/SKILL.md');
    });
  }
  if (Array.isArray(manifest.triggers)) manifest.triggers.forEach((trigger, index) => {
    if (!trigger || typeof trigger !== 'object') return;
    const secret = (trigger as Record<string, unknown>).secret_env;
    if (typeof secret === 'string' && !secrets.has(secret))
      missing(`triggers[${index}].secret_env`, secret, 'env.required or env.optional');
  });
  return issues;
}
