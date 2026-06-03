/**
 * API Type Definitions
 *
 * Centralized TypeScript types for all API models and responses
 * Re-exports shared types for convenience
 */

// Re-export core message types from shared package
export type {
  UnifiedMessage,
  ParsedMetadata,
} from '@agentpress/shared';

// ============================================================================
// Chat & Messages (API-specific)
// ============================================================================

export interface Message {
  message_id: string;
  thread_id: string;
  type: 'user' | 'assistant' | 'system' | 'cost' | 'summary' | 'status';
  is_llm_message: boolean;
  content: string | Record<string, any>;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  thread_id: string;
  project_id: string;
  account_id: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  agent_id: string | null;
  metadata: Record<string, any>;
  title?: string;
  project?: Project; // Nested project data (always included from API)
}

// Active agent run (from /agent-runs/active)
export interface ActiveAgentRun {
  thread_id: string;
  id: string;
  status: 'running';
  started_at: string;
}

// ============================================================================
// Projects
// ============================================================================

interface Project {
  id: string;
  name: string;
  description: string;
  account_id: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean;
  // Icon system field for thread categorization
  icon_name?: string | null;
  [key: string]: any;
}

// ============================================================================
// Files & Sandbox
// ============================================================================

export interface SandboxFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  content?: string;
}

// ============================================================================
// Agents
// ============================================================================

export interface Agent {
  agent_id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  configured_mcps: Array<{
    name: string;
    config: Record<string, any>;
  }>;
  custom_mcps?: Array<{
    name: string;
    type: 'json' | 'sse';
    config: Record<string, any>;
    enabledTools: string[];
  }>;
  agentpress_tools: Record<string, any>;
  is_default: boolean;
  is_public?: boolean;
  marketplace_published_at?: string;
  download_count?: number;
  tags?: string[];
  created_at: string;
  updated_at: string;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
  current_version_id?: string | null;
  version_count?: number;
  current_version?: AgentVersion | null;
  metadata?: {
    template_name?: string;
    kortix_template_id?: string;
    is_kortix_team?: boolean;
    is_suna_default?: boolean;
    centrally_managed?: boolean;
    management_version?: string;
    restrictions?: {
      system_prompt_editable?: boolean;
      tools_editable?: boolean;
      name_editable?: boolean;
      mcps_editable?: boolean;
    };
    installation_date?: string;
    last_central_update?: string;
  };
}

interface AgentVersion {
  version_id: string;
  agent_id: string;
  version_number: number;
  version_name: string;
  system_prompt: string;
  model?: string;
  configured_mcps: Array<any>;
  custom_mcps: Array<any>;
  agentpress_tools: Record<string, any>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string;
  change_description?: string;
}

export interface AgentsResponse {
  agents: Agent[];
  pagination: PaginationInfo;
}

interface PaginationInfo {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

export interface AgentsParams {
  page?: number;
  limit?: number;
  search?: string;
  sort_by?: string;
  sort_order?: string;
  has_default?: boolean;
  has_mcp_tools?: boolean;
  has_agentpress_tools?: boolean;
  tools?: string;
  content_type?: string;
}

export interface AgentUpdateRequest {
  name?: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  configured_mcps?: Array<{
    name: string;
    config: Record<string, any>;
  }>;
  custom_mcps?: Array<{
    name: string;
    type: 'json' | 'sse';
    config: Record<string, any>;
    enabledTools: string[];
  }>;
  agentpress_tools?: Record<string, any>;
  is_default?: boolean;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
  replace_mcps?: boolean;
}

// ============================================================================
// Models
// ============================================================================

export interface Model {
  id: string;
  display_name: string;
  short_name?: string;
  requires_subscription?: boolean;
  is_available?: boolean;
  input_cost_per_million_tokens?: number | null;
  output_cost_per_million_tokens?: number | null;
  max_tokens?: number | null;
  context_window?: number;
  capabilities?: string[];
  recommended?: boolean;
  priority?: number;
}

export interface AvailableModelsResponse {
  models: Model[];
  subscription_tier: string;
  total_models: number;
}

// ===== TRIGGER TYPES =====

export interface TriggerConfiguration {
  trigger_id: string;
  agent_id: string;
  trigger_type: string;
  provider_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  config?: Record<string, any>;
}

export interface TriggerResponse {
  trigger_id: string;
  agent_id: string;
  trigger_type: string;
  provider_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  config: Record<string, any>;
}

export interface TriggerApp {
  slug: string;
  name: string;
  logo: string;
}

// Composio Event Trigger Types
export interface ComposioTriggerType {
  slug: string;
  name: string;
  description?: string;
  type: string;
  instructions?: string;
  config?: {
    title?: string;
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  payload?: Record<string, any>;
  toolkit: {
    slug: string;
    name: string;
    logo?: string;
  };
}

export interface ComposioAppsWithTriggersResponse {
  success: boolean;
  items: TriggerApp[];
  total: number;
}

export interface ComposioAppTriggersResponse {
  success: boolean;
  items: ComposioTriggerType[];
  toolkit: {
    slug: string;
    name: string;
    logo?: string;
  };
  total: number;
}

export interface CreateComposioEventTriggerRequest {
  agent_id: string;
  profile_id: string;
  slug: string;
  trigger_config: Record<string, any>;
  route: 'agent';
  name?: string;
  agent_prompt?: string;
  connected_account_id?: string;
  toolkit_slug?: string;
  model?: string;
}

export interface CreateComposioEventTriggerResponse {
  trigger_id: string;
  agent_id: string;
  [key: string]: any;
}

// Request/Response Types
export interface TriggerCreateRequest {
  provider_id: string;
  name: string;
  config: Record<string, any>;
  description?: string;
}

export interface TriggerUpdateRequest {
  config?: Record<string, any>;
  name?: string;
  description?: string;
  is_active?: boolean;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface SendMessageInput {
  threadId: string;
  message: string;
  modelName?: string;
  agentId?: string;
  files?: Array<{ uri: string; name: string; type: string }>;
}
