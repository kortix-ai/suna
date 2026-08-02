import { backendApi } from '../../http/api-client';
import type { AgentConfigBlock, OpencodeAgentConfig } from './agent-config';
import type { ChangeRequest } from './change-requests';
import { unwrap } from './shared';

export type AgentProfileSection =
  | 'instructions'
  | 'integrations'
  | 'knowledge'
  | 'skills'
  | 'automations'
  | 'advanced';

export type AgentProfileRisk = 'low' | 'medium' | 'high';
export type AgentProfileStatus = 'published' | 'draft' | 'publishing' | 'conflict';

export interface AgentProfileEditor {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  last_seen_at: string;
}

export interface AgentProfileIntegration {
  profile_id: string;
  slug: string;
  provider: string;
  display_name: string;
  scopes: string[];
  can_write: boolean;
  status: 'available' | 'pending_publication' | 'revoked' | 'error';
  error: string | null;
}

export interface AgentProfileSkill {
  slug: string;
  name: string;
  description: string | null;
  origin: 'project' | 'marketplace' | 'archive' | 'github' | 'generated';
  status: 'available' | 'pending_publication' | 'error';
  files?: AgentProfileSkillFile[];
}

export interface AgentProfileSkillFile {
  path: string;
  content: string;
}

export interface AgentProfileAutomation {
  slug: string;
  name: string;
  prompt?: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  next_runs: string[];
  status: 'active' | 'paused' | 'pending_publication' | 'error';
}

export interface AgentProfileSections {
  instructions?: OpencodeAgentConfig;
  integrations?: AgentProfileIntegration[];
  knowledge?: string[];
  skills?: AgentProfileSkill[];
  automations?: AgentProfileAutomation[];
  advanced?: AgentConfigBlock;
}

export interface AgentProfileImpactSummary {
  data_access: string[];
  actions: string[];
  schedule_changes: string[];
  cost_sensitive_settings: string[];
}

export interface AgentProfileChange {
  section: AgentProfileSection;
  risk: AgentProfileRisk;
  kind: 'add' | 'update' | 'remove' | 'revoke' | 'pause';
  summary: string;
  resource_id?: string;
}

export interface AgentProfileDraft {
  project_id: string;
  agent_name: string;
  revision: number;
  base_revision: string | null;
  sections: AgentProfileSections;
  changed_sections: AgentProfileSection[];
  changes: AgentProfileChange[];
  highest_risk: AgentProfileRisk;
  impact: AgentProfileImpactSummary;
  active_editors: AgentProfileEditor[];
  updated_at: string;
  updated_by: string;
}

export interface AgentProfile {
  project_id: string;
  agent_name: string;
  is_default: boolean;
  status: AgentProfileStatus;
  published_revision: string | null;
  revision: number;
  sections: AgentProfileSections;
  draft: AgentProfileDraft | null;
  knowledge_sources: AgentKnowledgeSource[];
}

export interface AgentProfileDraftConflict {
  code: 'agent_profile_revision_conflict';
  expected_revision: number;
  current_revision: number;
  conflicting_sections: AgentProfileSection[];
  active_editors: AgentProfileEditor[];
}

export interface UpdateAgentProfileDraftInput {
  expectedRevision: number;
  sections: AgentProfileSections;
}

export interface AgentProfilePreview {
  draft: AgentProfileDraft;
  impact: AgentProfileImpactSummary;
  changes: AgentProfileChange[];
  technical_diff: Array<{
    path: string;
    before: string | null;
    after: string | null;
  }>;
}

export interface AgentProfileTestInput {
  expectedRevision: number;
  includePendingWriteIntegrations?: boolean;
}

export interface AgentProfileTestResult {
  session_id: string;
  branch: string;
  expires_at: string;
  excluded_integrations: string[];
}

export interface PublishAgentProfileInput {
  expectedRevision: number;
  acknowledgeHighRisk?: boolean;
}

export interface PublishAgentProfileResult {
  revision: number;
  branch: string;
  commit_sha: string;
  change_request: ChangeRequest;
  updated_existing_request: boolean;
}

export interface PauseAgentProfileAutomationResult {
  ok: true;
  slug: string;
  paused_at: string;
  cancelled_executions: number;
}

export type AgentKnowledgeSourceType = 'upload' | 'url' | 'connector';
export type AgentKnowledgeSyncStatus =
  | 'draft'
  | 'pending'
  | 'syncing'
  | 'ready'
  | 'degraded'
  | 'error'
  | 'revoked';

export interface AgentKnowledgeVersion {
  version_id: string;
  source_id: string;
  status: 'processing' | 'active' | 'failed' | 'superseded';
  content_hash: string | null;
  chunk_count: number;
  embedding_model: string | null;
  lexical_only: boolean;
  created_at: string;
  promoted_at: string | null;
  error: string | null;
}

export interface AgentKnowledgeSource {
  source_id: string;
  project_id: string;
  agent_name: string;
  slug: string;
  type: AgentKnowledgeSourceType;
  title: string;
  privacy: 'private';
  status: AgentKnowledgeSyncStatus;
  url: string | null;
  connector_profile_id: string | null;
  resource_id: string | null;
  automatic_sync: boolean;
  sync_interval_hours: number | null;
  last_successful_sync_at: string | null;
  last_sync_attempt_at: string | null;
  next_sync_at: string | null;
  error: string | null;
  active_version: AgentKnowledgeVersion | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentKnowledgeSourceInput {
  type: 'url' | 'connector';
  title: string;
  url?: string;
  connectorProfileId?: string;
  resourceId?: string;
  /** Selected read-only executor action. The connected-resource picker supplies this. */
  connectorAction?: string;
  /** Input field that receives `resourceId`. The connected-resource picker supplies this. */
  resourceArgument?: string;
  automaticSync?: boolean;
}

export interface CreateAgentKnowledgeUploadInput {
  fileName: string;
  contentType: string;
  size: number;
}

export interface UploadAgentKnowledgeFileInput {
  fileName: string;
  contentType: string;
  data: Blob;
}

export interface AgentKnowledgeUpload {
  source: AgentKnowledgeSource;
  signed_upload_url: string;
  upload_token: string;
  storage_path: string;
  expires_at: string;
}

export interface AgentProfileSkillStageResult {
  skills: Array<{
    slug: string;
    name: string;
    description: string;
    files: AgentProfileSkillFile[];
  }>;
  draft: AgentProfileDraft;
}

export interface ImportAgentProfileSkillArchiveInput {
  fileName: string;
  dataBase64: string;
}

export interface GenerateAgentProfileSkillInput {
  name?: string;
  brief: string;
}

const agentBase = (projectId: string, agentName: string) =>
  `/projects/${projectId}/agents/${encodeURIComponent(agentName)}`;

export async function getAgentProfile(projectId: string, agentName: string) {
  return unwrap(await backendApi.get<AgentProfile>(`${agentBase(projectId, agentName)}/profile`));
}

export async function pauseAgentProfileAutomation(
  projectId: string,
  agentName: string,
  automationSlug: string,
) {
  return unwrap(
    await backendApi.post<PauseAgentProfileAutomationResult>(
      `${agentBase(projectId, agentName)}/profile/automations/${encodeURIComponent(automationSlug)}/pause`,
      {},
    ),
  );
}

export async function updateAgentProfileDraft(
  projectId: string,
  agentName: string,
  input: UpdateAgentProfileDraftInput,
) {
  return unwrap(
    await backendApi.put<AgentProfileDraft>(
      `${agentBase(projectId, agentName)}/profile/draft`,
      input,
    ),
  );
}

export async function previewAgentProfile(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.post<AgentProfilePreview>(
      `${agentBase(projectId, agentName)}/profile/preview`,
    ),
  );
}

export async function testAgentProfileDraft(
  projectId: string,
  agentName: string,
  input: AgentProfileTestInput,
) {
  return unwrap(
    await backendApi.post<AgentProfileTestResult>(
      `${agentBase(projectId, agentName)}/profile/test`,
      input,
    ),
  );
}

export async function publishAgentProfile(
  projectId: string,
  agentName: string,
  input: PublishAgentProfileInput,
) {
  return unwrap(
    await backendApi.post<PublishAgentProfileResult>(
      `${agentBase(projectId, agentName)}/profile/publish`,
      input,
    ),
  );
}

export async function discardAgentProfileDraft(
  projectId: string,
  agentName: string,
  input: { expectedRevision: number },
) {
  return unwrap(
    await backendApi.post<{ ok: true }>(
      `${agentBase(projectId, agentName)}/profile/discard`,
      input,
    ),
  );
}

export async function importAgentProfileSkillArchive(
  projectId: string,
  agentName: string,
  input: ImportAgentProfileSkillArchiveInput,
) {
  return unwrap(
    await backendApi.post<AgentProfileSkillStageResult>(
      `${agentBase(projectId, agentName)}/profile/skills/import`,
      input,
    ),
  );
}

export async function installAgentProfileMarketplaceSkill(
  projectId: string,
  agentName: string,
  input: { itemId: string },
) {
  return unwrap(
    await backendApi.post<AgentProfileSkillStageResult>(
      `${agentBase(projectId, agentName)}/profile/skills/marketplace`,
      input,
    ),
  );
}

export async function importAgentProfileSkillFromGitHub(
  projectId: string,
  agentName: string,
  input: { url: string },
) {
  return unwrap(
    await backendApi.post<AgentProfileSkillStageResult>(
      `${agentBase(projectId, agentName)}/profile/skills/github`,
      input,
    ),
  );
}

export async function generateAgentProfileSkill(
  projectId: string,
  agentName: string,
  input: GenerateAgentProfileSkillInput,
) {
  return unwrap(
    await backendApi.post<AgentProfileSkillStageResult>(
      `${agentBase(projectId, agentName)}/profile/skills/generate`,
      input,
    ),
  );
}

export async function listAgentKnowledgeSources(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.get<{ sources: AgentKnowledgeSource[] }>(
      `${agentBase(projectId, agentName)}/knowledge`,
    ),
  );
}

export async function createAgentKnowledgeSource(
  projectId: string,
  agentName: string,
  input: CreateAgentKnowledgeSourceInput,
) {
  return unwrap(
    await backendApi.post<AgentKnowledgeSource>(
      `${agentBase(projectId, agentName)}/knowledge/sources`,
      input,
    ),
  );
}

export async function createAgentKnowledgeUpload(
  projectId: string,
  agentName: string,
  input: CreateAgentKnowledgeUploadInput,
) {
  return unwrap(
    await backendApi.post<AgentKnowledgeUpload>(
      `${agentBase(projectId, agentName)}/knowledge/uploads`,
      input,
    ),
  );
}

export async function completeAgentKnowledgeUpload(
  projectId: string,
  agentName: string,
  sourceId: string,
  input: { uploadToken: string },
) {
  return unwrap(
    await backendApi.post<AgentKnowledgeSource>(
      `${agentBase(projectId, agentName)}/knowledge/${encodeURIComponent(sourceId)}/complete`,
      input,
    ),
  );
}

/** Upload one private knowledge file and complete its ingestion handshake. */
export async function uploadAgentKnowledgeFile(
  projectId: string,
  agentName: string,
  input: UploadAgentKnowledgeFileInput,
) {
  const upload = await createAgentKnowledgeUpload(projectId, agentName, {
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.data.size,
  });
  const body = new FormData();
  body.append('cacheControl', '3600');
  body.append('', input.data);
  const response = await fetch(upload.signed_upload_url, {
    method: 'PUT',
    headers: { 'x-upsert': 'false' },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(
      detail
        ? `Knowledge file upload failed (${response.status}): ${detail}`
        : `Knowledge file upload failed (${response.status}).`,
    );
  }
  return completeAgentKnowledgeUpload(projectId, agentName, upload.source.source_id, {
    uploadToken: upload.upload_token,
  });
}

export async function syncAgentKnowledgeSource(
  projectId: string,
  agentName: string,
  sourceId: string,
) {
  return unwrap(
    await backendApi.post<AgentKnowledgeSource>(
      `${agentBase(projectId, agentName)}/knowledge/${encodeURIComponent(sourceId)}/sync`,
    ),
  );
}

export async function revokeAgentKnowledgeSource(
  projectId: string,
  agentName: string,
  sourceId: string,
) {
  return unwrap(
    await backendApi.delete<{ ok: true }>(
      `${agentBase(projectId, agentName)}/knowledge/${encodeURIComponent(sourceId)}`,
    ),
  );
}
