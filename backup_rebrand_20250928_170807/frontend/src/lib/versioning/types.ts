export interface VersionId {
  value: string;
}

export interface AgentId {
  value: string;
}

export interface UserId {
  value: string;
}

export interface VersionNumber {
  value: number;
}

export interface MCPConfiguration {
  name: string;
  type: string;
  config: Record<string, any>;
  enabledTools: string[];
}

export interface ToolConfiguration {
  tools: Record<string, any>;
}

export interface AgentVersion {
  versionId: VersionId;
  agentId: AgentId;
  versionNumber: VersionNumber;
  versionName: string;
  systemPrompt: string;
  model?: string;
  configuredMcps: MCPConfiguration[];
  customMcps: MCPConfiguration[];
  toolConfiguration: ToolConfiguration;
  agentpress_tools: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: UserId;
  changeDescription?: string;
}

export interface VersionDifference {
  field: string;
  type: 'added' | 'removed' | 'modified';
  oldValue?: any;
  newValue?: any;
}

export interface VersionComparison {
  version1: AgentVersion;
  version2: AgentVersion;
  differences: VersionDifference[];
}

export interface CreateVersionRequest {
  system_prompt: string;
  model?: string;
  configured_mcps: Array<Record<string, any>>;
  custom_mcps: Array<Record<string, any>>;
  agentpress_tools: Record<string, any>;
  version_name?: string;
  description?: string;
}

export interface UpdateVersionDetailsRequest {
  version_name?: string;
  change_description?: string;
}

export interface VersionResponse {
  version_id: string;
  agent_id: string;
  version_number: number;
  version_name: string;
  system_prompt: string;
  model?: string;
  configured_mcps: Array<Record<string, any>>;
  custom_mcps: Array<Record<string, any>>;
  agentpress_tools: Record<string, any>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  change_description?: string;
} 