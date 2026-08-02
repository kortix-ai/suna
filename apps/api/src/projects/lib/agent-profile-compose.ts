import {
  SLUG_RE,
  type AgentBlockV2,
  type ManifestIssue,
  validateAgentMdFrontmatter,
  validateManifest,
} from '@kortix/manifest-schema';
import { serializeAgentMarkdown, type ParsedAgentMarkdown } from './agent-markdown';
import { applyAgentBlockV2, readAgentBlockV2 } from './agent-config-v2';
import { KNOWN_BEHAVIOR_KEYS, agentMarkdownPath } from './compile-agent-config';
import type { AgentProfileSections } from './agent-profile-risk';
import {
  extractTriggers,
  serializeManifest,
  type GitTriggerSpec,
  type ParsedManifest,
} from '../triggers';
import {
  draftToSpec,
  parseTriggerDraft,
  removeTriggerFromManifest,
  specToBody,
  upsertTriggerInManifest,
} from './triggers';

export type AgentProfileFile = { path: string; content: string };

export type ComposeAgentProfileResult =
  | {
      ok: true;
      files: AgentProfileFile[];
      technicalDiff: Array<{ path: string; before: string | null; after: string | null }>;
      manifest: ParsedManifest;
    }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: string;
      error: string;
      issues?: ManifestIssue[];
    };

function fail(
  status: 400 | 404 | 409,
  code: string,
  error: string,
  issues?: ManifestIssue[],
): Extract<ComposeAgentProfileResult, { ok: false }> {
  return issues ? { ok: false, status, code, error, issues } : { ok: false, status, code, error };
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function slugs(value: unknown): string[] {
  return records(value)
    .map((entry) => entry.slug)
    .filter((entry): entry is string => typeof entry === 'string' && SLUG_RE.test(entry));
}

function explicitStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && SLUG_RE.test(entry))
    : [];
}

function composeSkillFiles(
  value: unknown,
): { ok: true; files: AgentProfileFile[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, files: [] };
  const files: AgentProfileFile[] = [];
  const paths = new Set<string>();
  for (const skill of records(value)) {
    const slug = typeof skill.slug === 'string' ? skill.slug : '';
    if (!SLUG_RE.test(slug)) return { ok: false, error: 'Pending skill slug is invalid.' };
    for (const file of records(skill.files)) {
      const path = typeof file.path === 'string' ? file.path : '';
      const content = typeof file.content === 'string' ? file.content : null;
      const prefix = `.kortix/opencode/skills/${slug}/`;
      if (
        !path.startsWith(prefix) ||
        path.includes('\\') ||
        path.split('/').includes('..') ||
        content === null
      ) {
        return { ok: false, error: `Pending skill "${slug}" contains an invalid file.` };
      }
      if (paths.has(path)) {
        return { ok: false, error: `Pending skill file "${path}" is duplicated.` };
      }
      paths.add(path);
      files.push({ path, content });
    }
  }
  return { ok: true, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

function composeBehavior(
  agentName: string,
  current: ParsedAgentMarkdown,
  instructionsValue: unknown,
): { ok: true; content: string } | { ok: false; issues: ManifestIssue[]; error: string } {
  if (instructionsValue === undefined) {
    return { ok: true, content: serializeAgentMarkdown(current.frontmatter, current.body) };
  }
  const instructions = record(instructionsValue);
  const frontmatter = { ...current.frontmatter };
  for (const key of KNOWN_BEHAVIOR_KEYS) delete frontmatter[key];
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (instructions[key] !== undefined) frontmatter[key] = instructions[key];
  }
  const issues: ManifestIssue[] = [];
  validateAgentMdFrontmatter(frontmatter, `agents.${agentName}`, issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    return {
      ok: false,
      issues: errors,
      error: errors.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    };
  }
  const prompt = typeof instructions.prompt === 'string' ? instructions.prompt : current.body;
  return { ok: true, content: serializeAgentMarkdown(frontmatter, prompt) };
}

function automationSpec(input: {
  automation: Record<string, unknown>;
  existing: GitTriggerSpec | undefined;
  agentName: string;
  manifestPath: string;
}): GitTriggerSpec | { error: string } {
  const schedule = typeof input.automation.schedule === 'string' ? input.automation.schedule : '';
  const isRunAt = schedule.includes('T') && !Number.isNaN(Date.parse(schedule));
  const body = {
    ...(input.existing ? specToBody(input.existing) : {}),
    slug: input.automation.slug,
    name: input.automation.name,
    type: 'cron',
    agent: input.agentName,
    enabled:
      input.automation.enabled === true && input.automation.status !== 'paused',
    timezone: input.automation.timezone,
    prompt_template:
      (typeof input.automation.prompt === 'string' && input.automation.prompt.trim()) ||
      input.existing?.promptTemplate ||
      `Run the scheduled automation "${String(input.automation.name ?? input.automation.slug)}".`,
    ...(isRunAt ? { run_at: new Date(schedule).toISOString(), cron: null } : { cron: schedule, run_at: null }),
  };
  const parsed = parseTriggerDraft(body, { existingSlug: input.existing?.slug ?? null });
  if ('error' in parsed) return parsed;
  return draftToSpec(parsed, input.manifestPath);
}

function composeAutomations(
  manifest: ParsedManifest,
  agentName: string,
  value: unknown,
): ParsedManifest | { error: string; code: string } {
  if (value === undefined) return manifest;
  const loaded = extractTriggers(manifest);
  if (loaded.errors.length > 0) {
    return {
      code: 'trigger_manifest_invalid',
      error: loaded.errors.map((entry) => `${entry.slug}: ${entry.error}`).join('; '),
    };
  }
  const desired = records(value);
  const bySlug = new Map(loaded.specs.map((spec) => [spec.slug, spec]));
  for (const automation of desired) {
    const slug = typeof automation.slug === 'string' ? automation.slug : '';
    const owner = bySlug.get(slug);
    if (owner && owner.agent !== agentName) {
      return {
        code: 'trigger_slug_conflict',
        error: `Schedule slug "${slug}" belongs to agent "${owner.agent}".`,
      };
    }
  }

  let next = manifest;
  const desiredSlugs = new Set(
    desired.map((entry) => entry.slug).filter((slug): slug is string => typeof slug === 'string'),
  );
  for (const existing of loaded.specs) {
    if (existing.type === 'cron' && existing.agent === agentName && !desiredSlugs.has(existing.slug)) {
      next = removeTriggerFromManifest(next, existing.slug);
    }
  }
  for (const automation of desired) {
    const slug = typeof automation.slug === 'string' ? automation.slug : '';
    const spec = automationSpec({
      automation,
      existing: bySlug.get(slug),
      agentName,
      manifestPath: manifest.path,
    });
    if ('error' in spec) return { code: 'invalid_schedule', error: spec.error };
    next = upsertTriggerInManifest(next, spec);
  }
  return next;
}

export function composeAgentProfileFiles(input: {
  manifest: ParsedManifest;
  agentName: string;
  behavior: ParsedAgentMarkdown;
  behaviorExists?: boolean;
  sections: AgentProfileSections;
}): ComposeAgentProfileResult {
  const read = readAgentBlockV2(input.manifest, input.agentName);
  if (!read.ok) return fail(400, 'manifest_malformed', read.error);
  if (read.schemaVersion !== 2) {
    return fail(400, 'v2_required', 'Agent profiles require a kortix_version 2 manifest.');
  }
  if (!read.block) return fail(404, 'agent_not_found', 'Agent not found.');

  const currentBlock = read.block as AgentBlockV2 & Record<string, unknown>;
  const nextBlock = {
    ...currentBlock,
    ...record(input.sections.advanced),
  } as Record<string, unknown>;
  delete nextBlock.opencode;
  if (input.sections.integrations !== undefined) {
    nextBlock.connectors = slugs(input.sections.integrations);
    const required = Array.isArray(nextBlock.connectors_required)
      ? nextBlock.connectors_required.filter((slug) => (nextBlock.connectors as string[]).includes(slug))
      : [];
    if (required.length > 0) nextBlock.connectors_required = required;
    else delete nextBlock.connectors_required;
  }
  if (input.sections.knowledge !== undefined) {
    nextBlock.knowledge = explicitStrings(input.sections.knowledge);
  }
  if (input.sections.skills !== undefined) {
    nextBlock.skills = slugs(input.sections.skills);
  }

  const applied = applyAgentBlockV2(input.manifest, input.agentName, nextBlock as AgentBlockV2);
  if (!applied.ok) return fail(400, 'invalid_profile', applied.error, applied.issues);
  let nextManifest: ParsedManifest = { ...input.manifest, raw: applied.raw };
  const automated = composeAutomations(nextManifest, input.agentName, input.sections.automations);
  if ('error' in automated) return fail(409, automated.code, automated.error);
  nextManifest = automated;

  const manifestValidation = validateManifest(nextManifest.raw, nextManifest.format);
  const manifestErrors = manifestValidation.issues.filter((issue) => issue.severity === 'error');
  if (manifestErrors.length > 0) {
    return fail(
      400,
      'invalid_profile',
      manifestErrors.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      manifestErrors,
    );
  }

  const behavior = composeBehavior(input.agentName, input.behavior, input.sections.instructions);
  if (!behavior.ok) return fail(400, 'invalid_instructions', behavior.error, behavior.issues);
  const skillFiles = composeSkillFiles(input.sections.skills);
  if (!skillFiles.ok) return fail(400, 'invalid_skill_files', skillFiles.error);

  const manifestPath = input.manifest.path;
  const behaviorPath = agentMarkdownPath(nextManifest.raw, input.agentName);
  const manifestBefore = serializeManifest(input.manifest);
  const manifestAfter = serializeManifest(nextManifest);
  const behaviorBefore = input.behaviorExists === false
    ? null
    : serializeAgentMarkdown(input.behavior.frontmatter, input.behavior.body);
  const files = [
    { path: manifestPath, content: manifestAfter },
    { path: behaviorPath, content: behavior.content },
    ...skillFiles.files,
  ];
  const technicalDiff = [
    { path: manifestPath, before: manifestBefore, after: manifestAfter },
    { path: behaviorPath, before: behaviorBefore, after: behavior.content },
    ...skillFiles.files.map((file) => ({ path: file.path, before: null, after: file.content })),
  ].filter((entry) => entry.before !== entry.after);

  return { ok: true, files, technicalDiff, manifest: nextManifest };
}
