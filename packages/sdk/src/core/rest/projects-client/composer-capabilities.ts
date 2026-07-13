import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'pi';
export type HarnessAuthKind =
  | 'managed_gateway'
  | 'claude_subscription'
  | 'anthropic_api_key'
  | 'codex_subscription'
  | 'openai_api_key'
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'native_config';

export interface HarnessConnection {
  id: HarnessAuthKind;
  kind: HarnessAuthKind;
  label: string;
  compatible_harnesses: HarnessId[];
  configured: boolean;
  ready: boolean;
  active_for: HarnessId[];
  reason: string | null;
  source: 'kortix' | 'project_secret' | 'native_config';
}

export interface ConfiguredModelProvider {
  provider_id: string;
  label: string;
}

export interface ComposerAgent {
  name: string;
  runtime: string;
  harness: HarnessId;
  native_agent: string | null;
  enabled: boolean;
}

export interface ComposerCapabilities {
  agent: ComposerAgent;
  auth: {
    compatible: HarnessAuthKind[];
    active: HarnessAuthKind | null;
    ready: boolean;
    reason: string | null;
  };
  model: {
    policy: 'gateway-catalog' | 'harness-catalog' | 'launch-override';
    default_allowed: boolean;
    custom_allowed: boolean;
    live_change: boolean;
    presets: Array<{ id: string; name: string; source: string }>;
  };
  can_start: boolean;
  blocking_reason: string | null;
}

export interface ComposerModelCatalog {
  agent: ComposerAgent;
  connection_id: HarnessAuthKind | null;
  policy: ComposerCapabilities['model']['policy'];
  default_allowed: boolean;
  custom_allowed: boolean;
  models: ComposerCapabilities['model']['presets'];
}

export async function listHarnessConnections(projectId: string) {
  return unwrap(
    await backendApi.get<{ connections: HarnessConnection[]; providers: ConfiguredModelProvider[] }>(
      `/projects/${projectId}/harness-connections`,
    ),
  );
}

export async function getComposerCapabilities(
  projectId: string,
  agentName: string,
  connectionId?: HarnessAuthKind | null,
) {
  const search = new URLSearchParams({ agent_name: agentName });
  if (connectionId) search.set('connection_id', connectionId);
  return unwrap(
    await backendApi.get<ComposerCapabilities>(
      `/projects/${projectId}/composer-capabilities?${search.toString()}`,
    ),
  );
}

export async function getComposerModelCatalog(
  projectId: string,
  input: { agentName: string; connectionId?: HarnessAuthKind | null },
) {
  const search = new URLSearchParams({ agent_name: input.agentName });
  if (input.connectionId) search.set('connection_id', input.connectionId);
  return unwrap(
    await backendApi.get<ComposerModelCatalog>(
      `/projects/${projectId}/model-catalog?${search.toString()}`,
    ),
  );
}

export async function setActiveHarnessConnection(
  projectId: string,
  harness: HarnessId,
  connectionId: HarnessAuthKind | null,
) {
  return unwrap(
    await backendApi.put<{ connections: HarnessConnection[]; providers: ConfiguredModelProvider[] }>(
      `/projects/${projectId}/harness-connections/${harness}/active`,
      { connection_id: connectionId },
    ),
  );
}
