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
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 'browser_state' | 'image_context';
  is_llm_message: boolean;
  content: string; // JSON string from backend
  metadata: string; // JSON string from backend
  created_at: string;
  updated_at: string;
  agent_id?: string;
  sequence?: number;
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
  stream_status?: 'chunk' | 'complete'; // Streaming status for assistant messages
  thread_run_id?: string;
  llm_response_id?: string;
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

export interface InitiateAgentResponse {
  thread_id: string;
  agent_run_id: string | null;
}

export interface InitiateAgentInput {
  prompt: string;
  files?: File[];
  agent_id?: string;
  model_name?: string;
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
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  model_name?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: string[];
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
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

