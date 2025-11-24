/**
 * API Type Definitions
 * 
 * Centralized TypeScript types for all API models and responses
 */

// ============================================================================
// Chat & Messages
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

// Core unified message type matching backend (used for streaming)
export interface UnifiedMessage {
  message_id: string | null; // null for transient stream chunks
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 'browser_state' | 'image_context' | 'llm_response_end' | 'llm_response_start';
  is_llm_message: boolean;
  content: string; // JSON string from backend
  metadata: string; // JSON string from backend
  created_at: string;
  updated_at: string;
  agent_id?: string;
  sequence?: number;
  sandbox_id?: string;
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

export interface AgentRun {
  id: string;
  thread_id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';
  model_name?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
}

// Parsed content structure (from message.content JSON string)
export interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: string; // The actual text content
  status_type?: string; // For status messages: 'tool_started', 'tool_completed', 'thread_run_end', etc.
  function_name?: string; // For tool calls
  xml_tag_name?: string; // XML tag for tool
  arguments?: any; // Tool arguments
  tool_index?: number; // Index of tool in sequence
  result?: any; // For tool results
  is_error?: boolean; // Tool execution error
  message?: string; // Error/status messages
  name?: string; // Tool name
  [key: string]: any;
}

// Parsed metadata structure (from message.metadata JSON string)
export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk'; // Streaming status for assistant messages
  thread_run_id?: string;
  llm_response_id?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, any> | string; // String when partial JSON, object when complete
    source: 'native' | 'xml';
  }>;
  // Tool message metadata fields
  function_name?: string; // Tool function name
  tool_call_id?: string; // Tool call ID
  result?: {
    output: any;
    success: boolean;
    error?: string | null;
  };
  return_format?: 'native' | 'xml';
  assistant_message_id?: string; // Link tool result back to assistant message
  [key: string]: any;
}

export interface StreamEvent {
  event: string;
  data: string;
}

// Active agent run (from /agent-runs/active)
export interface ActiveAgentRun {
  thread_id: string;
  id: string;
  status: 'running';
  started_at: string;
}

export interface UnifiedAgentStartResponse {
  thread_id: string;
  agent_run_id: string;
  status: string;
}

// ============================================================================
// Projects
// ============================================================================

export interface Project {
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

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  is_public?: boolean;
}

// ============================================================================
// Files & Sandbox
// ============================================================================

export interface FileManifest {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
  downloadUrl?: string;
}

export interface FolderStructure {
  id: string;
  name: string;
  path: string;
  files: FileManifest[];
  folders: FolderStructure[];
}

export interface SandboxFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  content?: string;
}

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  localUri?: string;
  isUploading?: boolean;
  uploadError?: string;
  cachedBlob?: Blob;
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

export interface AgentVersion {
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

export interface PaginationInfo {
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

export interface AgentCreateRequest {
  name: string;
  description?: string;
  system_prompt?: string;
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

export interface TriggerProvider {
  provider_id: string;
  name: string;
  description?: string;
  trigger_type: string;
  webhook_enabled: boolean;
  config_schema: Record<string, any>;
}

export interface TriggerWithAgent {
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
  // Agent details
  agent_name: string;
  agent_description?: string;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
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

export interface ProviderResponse {
  provider_id: string;
  name: string;
  description?: string;
  trigger_type: string;
  webhook_enabled: boolean;
  config_schema: Record<string, any>;
}

// Trigger Config Interfaces
export interface ScheduleTriggerConfig {
  cron_expression: string;
  agent_prompt?: string;
  timezone?: string;
}

export interface EventTriggerConfig {
  profile_id?: string;
  agent_prompt: string;
  trigger_slug: string;
  composio_trigger_id?: string;
}

export interface WebhookTriggerConfig {
  webhook_url?: string;
  secret?: string;
  headers_validation?: Record<string, string>;
  expected_content_type?: string;
}

export interface TelegramTriggerConfig {
  bot_token: string;
  secret_token?: string;
  allowed_users?: number[];
  allowed_chats?: number[];
  trigger_commands?: string[];
  trigger_keywords?: string[];
  respond_to_all_messages?: boolean;
  response_mode?: 'reply' | 'new_message';
}

export interface SlackTriggerConfig {
  signing_secret: string;
  bot_token?: string;
  allowed_channels?: string[];
  trigger_keywords?: string[];
  respond_to_mentions?: boolean;
  respond_to_direct_messages?: boolean;
}

export interface GitHubTriggerConfig {
  secret: string;
  events: string[];
  repository?: string;
}

export interface DiscordTriggerConfig {
  webhook_url: string;
  bot_token?: string;
  allowed_channels?: string[];
  trigger_keywords?: string[];
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

export interface TriggersResponse {
  triggers: TriggerConfiguration[];
}

export interface ProvidersResponse {
  providers: TriggerProvider[];
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface SendMessageInput {
  threadId: string;
  message: string;
  modelName?: string;
  agentId?: string;
  files?: UploadedFile[];
}

export interface FileUploadInput {
  sandboxId: string;
  file: File | Blob;
  path: string;
}

export interface FileUploadResponse {
  path: string;
  final_filename: string;
  size: number;
  type: string;
}

// ============================================================================
// Pagination & Filtering
// ============================================================================

export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ThreadsResponse {
  pagination: {
    limit: number;
    page: number;
    pages: number;
    total: number;
  };
  threads: Thread[];
}

// ============================================================================
// Error Types
// ============================================================================

export interface ApiErrorDetail {
  message: string;
  code?: string;
  field?: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
  detail?: ApiErrorDetail;
  status: number;
}

