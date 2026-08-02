import type { AgentBlockV2 } from '@kortix/manifest-schema';
import { extractTriggers, type ParsedManifest } from '../triggers';
import { nextTriggerScheduleSlot } from '../trigger-schedule';
import { readAgentBlockV2 } from './agent-config-v2';
import { readAgentMarkdown } from './agent-config-route-helpers';
import { KNOWN_BEHAVIOR_KEYS, agentMarkdownPath } from './compile-agent-config';
import type { ProjectRow } from './serializers';
import type { AgentProfileSections } from './agent-profile-risk';
import type { AgentProfileDraftRecord } from './agent-profile-drafts';
import type { AgentKnowledgeSourceRecord } from './agent-knowledge-sources';

function explicitGrant(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function nextRuns(
  spec: Parameters<typeof nextTriggerScheduleSlot>[0],
  count = 5,
): string[] {
  const runs: string[] = [];
  let cursor = new Date();
  for (let index = 0; index < count; index += 1) {
    const next = nextTriggerScheduleSlot(spec, cursor);
    if (!next) break;
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
}

export type PublishedAgentProfile = {
  baseRevision: string | null;
  isDefault: boolean;
  sections: AgentProfileSections;
};

export type LoadPublishedAgentProfileResult =
  | { ok: true; profile: PublishedAgentProfile }
  | { ok: false; status: 400 | 404 | 502; code: string; error: string };

export async function loadPublishedAgentProfile(input: {
  project: ProjectRow;
  manifest: ParsedManifest;
  agentName: string;
}): Promise<LoadPublishedAgentProfileResult> {
  const read = readAgentBlockV2(input.manifest, input.agentName);
  if (!read.ok) {
    return { ok: false, status: 400, code: 'manifest_malformed', error: read.error };
  }
  if (read.schemaVersion !== 2) {
    return {
      ok: false,
      status: 400,
      code: 'v2_required',
      error: 'Agent profiles require a kortix_version 2 manifest.',
    };
  }
  if (!read.block) {
    return { ok: false, status: 404, code: 'agent_not_found', error: 'Agent not found.' };
  }

  const path = agentMarkdownPath(input.manifest.raw, input.agentName);
  const behavior = await readAgentMarkdown(input.project, input.project.defaultBranch, path);
  if (behavior.state === 'read_error') {
    return { ok: false, status: 502, code: 'behavior_file_read', error: behavior.error };
  }

  const instructions: Record<string, unknown> = {};
  if (behavior.state === 'exists') {
    for (const key of KNOWN_BEHAVIOR_KEYS) {
      if (behavior.frontmatter[key] !== undefined) instructions[key] = behavior.frontmatter[key];
    }
    if (behavior.body.trim()) instructions.prompt = behavior.body.trim();
  }

  const block = read.block as AgentBlockV2 & Record<string, unknown>;
  const connectors = explicitGrant(block.connectors);
  const skills = explicitGrant(block.skills);
  const knowledge = explicitGrant(block.knowledge);
  const advanced = { ...block } as Record<string, unknown>;
  delete advanced.connectors;
  delete advanced.connectors_required;
  delete advanced.knowledge;
  delete advanced.skills;

  const loadedTriggers = extractTriggers(input.manifest);
  const automations = loadedTriggers.specs
    .filter((trigger) => trigger.type === 'cron' && trigger.agent === input.agentName)
    .map((trigger) => ({
      slug: trigger.slug,
      name: trigger.name,
      prompt: trigger.promptTemplate,
      enabled: trigger.enabled,
      schedule: trigger.runAt ?? trigger.cron ?? '',
      timezone: trigger.timezone,
      next_runs: nextRuns(trigger),
      status: trigger.enabled ? 'active' : 'paused',
    }));

  return {
    ok: true,
    profile: {
      baseRevision: input.manifest.revision ?? null,
      isDefault: read.defaultAgent === input.agentName,
      sections: {
        instructions,
        integrations: connectors.map((slug) => ({
          profile_id: slug,
          slug,
          provider: slug.split(/[-_]/)[0] || slug,
          display_name: titleFromSlug(slug),
          scopes: [],
          can_write: false,
          status: 'available',
          error: null,
        })),
        knowledge,
        skills: skills.map((slug) => ({
          slug,
          name: titleFromSlug(slug),
          description: null,
          origin: 'project',
          status: 'available',
        })),
        automations,
        advanced,
      },
    },
  };
}

export function serializeAgentProfileDraft(draft: AgentProfileDraftRecord) {
  return {
    project_id: draft.projectId,
    agent_name: draft.agentName,
    revision: draft.revision,
    base_revision: draft.baseRevision,
    sections: draft.sections,
    changed_sections: draft.changedSections,
    changes: draft.changes,
    highest_risk: draft.highestRisk,
    impact: draft.impact,
    active_editors: draft.activeEditors.map((editor) => ({
      user_id: editor.userId,
      display_name: editor.displayName,
      avatar_url: editor.avatarUrl,
      last_seen_at: editor.lastSeenAt,
    })),
    updated_at: draft.updatedAt.toISOString(),
    updated_by: draft.updatedBy,
  };
}

export function serializeAgentKnowledgeVersion(
  version: AgentKnowledgeSourceRecord['activeVersion'],
) {
  if (!version) return null;
  return {
    version_id: version.versionId,
    source_id: version.sourceId,
    status: version.status,
    content_hash: version.contentHash,
    chunk_count: version.chunkCount,
    embedding_model: version.embeddingModel,
    lexical_only: version.lexicalOnly,
    created_at: version.createdAt.toISOString(),
    promoted_at: version.promotedAt?.toISOString() ?? null,
    error: version.error,
  };
}

export function serializeAgentKnowledgeSource(source: AgentKnowledgeSourceRecord) {
  return {
    source_id: source.sourceId,
    project_id: source.projectId,
    agent_name: source.agentName,
    slug: source.slug,
    type: source.sourceType,
    title: source.title,
    privacy: 'private' as const,
    status: source.status,
    url: source.url,
    connector_profile_id: source.connectorProfileId,
    resource_id: source.resourceId,
    automatic_sync: source.automaticSync,
    sync_interval_hours: source.syncIntervalHours,
    last_successful_sync_at: source.lastSuccessfulSyncAt?.toISOString() ?? null,
    last_sync_attempt_at: source.lastSyncAttemptAt?.toISOString() ?? null,
    next_sync_at: source.nextSyncAt?.toISOString() ?? null,
    error: source.lastError,
    active_version: serializeAgentKnowledgeVersion(source.activeVersion),
    created_at: source.createdAt.toISOString(),
    updated_at: source.updatedAt.toISOString(),
  };
}
