import { createClient } from '@/lib/supabase/client';
import { handleApiError } from './error-handler';
import posthog from 'posthog-js';

// Get backend URL from environment variables
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Set to keep track of agent runs that are known to be non-running
const nonRunningAgentRuns = new Set<string>();
// Map to keep track of active EventSource streams
const activeStreams = new Map<string, EventSource>();

/**
 * Helper function to safely cleanup EventSource connections
 * This ensures consistent cleanup and prevents memory leaks
 */
const cleanupEventSource = (agentRunId: string, reason?: string): void => {
  const stream = activeStreams.get(agentRunId);
  if (stream) {
    if (reason) {
      console.log(`[STREAM] Cleaning up EventSource for ${agentRunId}: ${reason}`);
    }
    
    // Close the connection
    if (stream.readyState !== EventSource.CLOSED) {
      stream.close();
    }
    
    // Remove from active streams
    activeStreams.delete(agentRunId);
  }
};

/**
 * Failsafe cleanup function to prevent memory leaks
 * Should be called periodically or during app teardown
 */
const cleanupAllEventSources = (reason = 'batch cleanup'): void => {
  console.log(`[STREAM] Running batch cleanup: ${activeStreams.size} active streams`);
  
  const streamIds = Array.from(activeStreams.keys());
  streamIds.forEach(agentRunId => {
    cleanupEventSource(agentRunId, reason);
  });
};

// Export cleanup function for external use
export { cleanupAllEventSources };

// Custom error for billing issues
export class BillingError extends Error {
  status: number;
  detail: { message: string; [key: string]: any }; // Allow other properties in detail

  constructor(
    status: number,
    detail: { message: string; [key: string]: any },
    message?: string,
  ) {
    super(message || detail.message || `Billing Error: ${status}`);
    this.name = 'BillingError';
    this.status = status;
    this.detail = detail;

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

// Custom error for agent run limit exceeded
export class AgentRunLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    running_thread_ids: string[];
    running_count: number;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      running_thread_ids: string[];
      running_count: number;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Agent Run Limit Exceeded: ${status}`);
    this.name = 'AgentRunLimitError';
    this.status = status;
    this.detail = detail;

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, AgentRunLimitError.prototype);
  }
}

export class AgentCountLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Agent Count Limit Exceeded: ${status}`);
    this.name = 'AgentCountLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, AgentCountLimitError.prototype);
  }
}

export class ProjectLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Project Limit Exceeded: ${status}`);
    this.name = 'ProjectLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ProjectLimitError.prototype);
  }
}

export class NoAccessTokenAvailableError extends Error {
  constructor(message?: string, options?: { cause?: Error }) {
    super(message || 'No access token available', options);
  }
  name = 'NoAccessTokenAvailableError';
}

export type Project = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean; // Flag to indicate if the project is public
  // Icon system field for thread categorization
  icon_name?: string | null;
  [key: string]: any; // Allow additional properties to handle database fields
};

export type Thread = {
  thread_id: string;
  project_id?: string | null;
  is_public?: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: any; // Allow additional properties to handle database fields
};

export type Message = {
  role: string;
  content: string;
  type: string;
  agent_id?: string;
  agents?: {
    name: string;
  };
};

export type AgentRun = {
  id: string;
  thread_id: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  started_at: string;
  completed_at: string | null;
  responses: Message[];
  error: string | null;
};

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export interface InitiateAgentResponse {
  thread_id: string;
  agent_run_id: string;
}

export interface HealthCheckResponse {
  status: string;
  timestamp: string;
  instance_id: string;
}

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
  permissions?: string;
}

// Project APIs
export const getProjects = async (): Promise<Project[]> => {
  try {
    const supabase = createClient();

    // Get the current user's ID to filter projects
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.error('Error getting current user:', userError);
      return [];
    }

    // If no user is logged in, return an empty array
    if (!userData.user) {
      return [];
    }

    // Query only projects where account_id matches the current user's ID
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('account_id', userData.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      // Handle permission errors specifically
      if (
        error.code === '42501' &&
        error.message.includes('has_role_on_account')
      ) {
        console.error(
          'Permission error: User does not have proper account access',
        );
        return []; // Return empty array instead of throwing
      }
      throw error;
    }

    // Map database fields to our Project type
    const mappedProjects: Project[] = (data || []).map((project) => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
      // Include icon field for thread categorization
      icon_name: project.icon_name,
    }));

    return mappedProjects;
  } catch (err) {
    console.error('Error fetching projects:', err);
    handleApiError(err, { operation: 'load projects', resource: 'projects' });
    // Return empty array for permission errors to avoid crashing the UI
    return [];
  }
};

export const getProject = async (projectId: string): Promise<Project> => {
  const supabase = createClient();

  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error) {
      // Handle the specific "no rows returned" error from Supabase
      if (error.code === 'PGRST116') {
        throw new Error(`Project not found or not accessible: ${projectId}`);
      }
      throw error;
    }

    // If project has a sandbox, ensure it's started
    if (data.sandbox?.id) {
      // Fire off sandbox activation without blocking
      const ensureSandboxActive = async () => {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();

          // For public projects, we don't need authentication
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          if (session?.access_token) {
            headers['Authorization'] = `Bearer ${session.access_token}`;
          }

          const response = await fetch(
            `${API_URL}/project/${projectId}/sandbox/ensure-active`,
            {
              method: 'POST',
              headers,
            },
          );

          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => 'No error details available');
            console.warn(
              `Failed to ensure sandbox is active: ${response.status} ${response.statusText}`,
              errorText,
            );
          }
        } catch (sandboxError) {
          console.warn('Failed to ensure sandbox is active:', sandboxError);
        }
      };

      // Start the sandbox activation without awaiting
      ensureSandboxActive();
    }

    // Map database fields to our Project type
    const mappedProject: Project = {
      id: data.project_id,
      name: data.name || '',
      description: data.description || '',
      is_public: data.is_public || false,
      created_at: data.created_at,
      sandbox: data.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    };

    return mappedProject;
  } catch (error) {
    console.error(`Error fetching project ${projectId}:`, error);
    handleApiError(error, { operation: 'load project', resource: `project ${projectId}` });
    throw error;
  }
};

export const createProject = async (
  projectData: { name: string; description: string },
  accountId?: string,
): Promise<Project> => {
  const supabase = createClient();

  // If accountId is not provided, we'll need to get the user's ID
  if (!accountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError) throw userError;
    if (!userData.user)
      throw new Error('You must be logged in to create a project');

    // In Basejump, the personal account ID is the same as the user ID
    accountId = userData.user.id;
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: projectData.name,
      description: projectData.description || null,
      account_id: accountId,
    })
    .select()
    .single();

  if (error) {
    handleApiError(error, { operation: 'create project', resource: 'project' });
    throw error;
  }

  const project = {
    id: data.project_id,
    name: data.name,
    description: data.description || '',
    created_at: data.created_at,
    sandbox: { id: '', pass: '', vnc_preview: '' },
  };
  return project;
};

export const updateProject = async (
  projectId: string,
  data: Partial<Project>,
): Promise<Project> => {
  const supabase = createClient();

  // Sanity check to avoid update errors
  if (!projectId || projectId === '') {
    console.error('Attempted to update project with invalid ID:', projectId);
    throw new Error('Cannot update project: Invalid project ID');
  }

  const { data: updatedData, error } = await supabase
    .from('projects')
    .update(data)
    .eq('project_id', projectId)
    .select()
    .single();

  if (error) {
    console.error('Error updating project:', error);
    handleApiError(error, { operation: 'update project', resource: `project ${projectId}` });
    throw error;
  }

  if (!updatedData) {
    const noDataError = new Error('No data returned from update');
    handleApiError(noDataError, { operation: 'update project', resource: `project ${projectId}` });
    throw noDataError;
  }

  // Dispatch a custom event to notify components about the project change
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('project-updated', {
        detail: {
          projectId,
          updatedData: {
            id: updatedData.project_id,
            name: updatedData.name,
            description: updatedData.description,
          },
        },
      }),
    );
  }

  // Return formatted project data - use same mapping as getProject
  const project = {
    id: updatedData.project_id,
    name: updatedData.name,
    description: updatedData.description || '',
    created_at: updatedData.created_at,
    sandbox: updatedData.sandbox || {
      id: '',
      pass: '',
      vnc_preview: '',
      sandbox_url: '',
    },
  };
  return project;
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const supabase = createClient();
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('project_id', projectId);

  if (error) {
    handleApiError(error, { operation: 'delete project', resource: `project ${projectId}` });
    throw error;
  }
};

// Thread APIs
export const getThreads = async (projectId?: string): Promise<Thread[]> => {
  const supabase = createClient();

  // Get the current user's ID to filter threads
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) {
    console.error('Error getting current user:', userError);
    return [];
  }

  // If no user is logged in, return an empty array
  if (!userData.user) {
    return [];
  }

  let query = supabase.from('threads').select('*');

  // Always filter by the current user's account ID
  query = query.eq('account_id', userData.user.id);

  if (projectId) {
    query = query.eq('project_id', projectId);
  }

  const { data, error } = await query;

  if (error) {
    handleApiError(error, { operation: 'load threads', resource: projectId ? `threads for project ${projectId}` : 'threads' });
    throw error;
  }

  const mappedThreads: Thread[] = (data || [])
    .map((thread) => ({
      thread_id: thread.thread_id,
      project_id: thread.project_id,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      metadata: thread.metadata,
    }));
  return mappedThreads;
};

export const getThread = async (threadId: string): Promise<Thread> => {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('threads')
    .select('*')
    .eq('thread_id', threadId)
    .single();

  if (error) {
    handleApiError(error, { operation: 'load thread', resource: `thread ${threadId}` });
    throw error;
  }

  return data;
};

export const createThread = async (projectId: string): Promise<Thread> => {
  const supabase = createClient();

  // If user is not logged in, redirect to login
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('You must be logged in to create a thread');
  }

  const { data, error } = await supabase
    .from('threads')
    .insert({
      project_id: projectId,
      account_id: user.id, // Use the current user's ID as the account ID
    })
    .select()
    .single();

  if (error) {
    handleApiError(error, { operation: 'create thread', resource: 'thread' });
    throw error;
  }
  return data;
};

export const addUserMessage = async (
  threadId: string,
  content: string,
): Promise<void> => {
  const supabase = createClient();

  // Format the message in the format the LLM expects - keep it simple with only required fields
  const message = {
    role: 'user',
    content: content,
  };

  // Insert the message into the messages table
  const { error } = await supabase.from('messages').insert({
    thread_id: threadId,
    type: 'user',
    is_llm_message: true,
    content: JSON.stringify(message),
  });

  if (error) {
    console.error('Error adding user message:', error);
    handleApiError(error, { operation: 'add message', resource: 'message' });
    throw new Error(`Error adding message: ${error.message}`);
  }
};

export const getMessages = async (threadId: string): Promise<Message[]> => {
  const supabase = createClient();

  let allMessages: Message[] = [];
  let from = 0;
  const batchSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('messages')
      .select(`
        *,
        agents:agent_id (
          name
        )
      `)
      .eq('thread_id', threadId)
      .neq('type', 'cost')
      .neq('type', 'summary')
      .order('created_at', { ascending: true })
      .range(from, from + batchSize - 1);

    if (error) {
      console.error('Error fetching messages:', error);
      handleApiError(error, { operation: 'load messages', resource: `messages for thread ${threadId}` });
      throw new Error(`Error getting messages: ${error.message}`);
    }

    if (data && data.length > 0) {
      allMessages = allMessages.concat(data);
      from += batchSize;
      hasMore = data.length === batchSize;
    } else {
      hasMore = false;
    }
  }

  // Extract context_usage from the latest llm_response_end message
  try {
    const llmResponseEndMessages = allMessages.filter(msg => msg.type === 'llm_response_end');
    
    // Find the most recent llm_response_end message
    if (llmResponseEndMessages.length > 0) {
      const latestMsg = llmResponseEndMessages[llmResponseEndMessages.length - 1];
      try {
        const content = typeof latestMsg.content === 'string' ? JSON.parse(latestMsg.content) : latestMsg.content;
        if (content?.usage?.total_tokens) {
          // Store context usage
          const { useContextUsageStore } = await import('@/lib/stores/context-usage-store');
          useContextUsageStore.getState().setUsage(threadId, {
            current_tokens: content.usage.total_tokens
          });
        }
      } catch (e) {
        console.warn('Failed to parse llm_response_end message:', e);
      }
    }
  } catch (e) {
    console.warn('Failed to extract context_usage from llm_response_end:', e);
  }

  return allMessages;
};

// Agent APIs
export const startAgent = async (
  threadId: string,
  options?: {
    model_name?: string;
    agent_id?: string; // Optional again
  },
): Promise<{ agent_run_id: string }> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    // Check if backend URL is configured
    if (!API_URL) {
      throw new Error(
        'Backend URL is not configured. Set NEXT_PUBLIC_BACKEND_URL in your environment.',
      );
    }

    const defaultOptions = {
      model_name: 'anthropic/claude-3-7-sonnet-latest',
    };

    const finalOptions = { ...defaultOptions, ...options };

    const body: any = {
      model_name: finalOptions.model_name,
      stream: true, // Always stream for better UX
    };
    
    // Only include agent_id if it's provided
    if (finalOptions.agent_id) {
      body.agent_id = finalOptions.agent_id;
    }

    const response = await fetch(`${API_URL}/thread/${threadId}/agent/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 402) {
        try {
          const errorData = await response.json();
          const detail = errorData?.detail || { message: 'Payment Required' };
          if (typeof detail.message !== 'string') {
            detail.message = 'Payment Required';
          }
          throw new BillingError(response.status, detail);
        } catch (parseError) {
          throw new BillingError(
            response.status,
            { message: 'Payment Required' },
            `Error starting agent: ${response.statusText} (402)`,
          );
        }
      }

      if (response.status === 429) {
          const errorData = await response.json();
          const detail = errorData?.detail || { 
            message: 'Too many agent runs running',
            running_thread_ids: [],
            running_count: 0,
          };
          if (typeof detail.message !== 'string') {
            detail.message = 'Too many agent runs running';
          }
          if (!Array.isArray(detail.running_thread_ids)) {
            detail.running_thread_ids = [];
          }
          if (typeof detail.running_count !== 'number') {
            detail.running_count = 0;
          }
          throw new AgentRunLimitError(response.status, detail);
      }

      // Check for project limit errors (402 with PROJECT_LIMIT_EXCEEDED error_code)
      if (response.status === 402) {
        try {
          const errorData = await response.json();
          const detail = errorData?.detail || {};
          
          if (detail.error_code === 'PROJECT_LIMIT_EXCEEDED') {
            throw new ProjectLimitError(response.status, {
              message: detail.message || 'Project limit exceeded',
              current_count: detail.current_count || 0,
              limit: detail.limit || 0,
              tier_name: detail.tier_name || 'none',
              error_code: detail.error_code
            });
          }
        } catch (parseError) {
          if (parseError instanceof ProjectLimitError) {
            throw parseError;
          }
          // If it's not a project limit error, continue to general error handling
        }
      }

      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `[API] Error starting agent: ${response.status} ${response.statusText}`,
      );
      throw new Error(
        `Error starting agent: ${response.statusText} (${response.status})`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    if (error instanceof BillingError || error instanceof AgentRunLimitError) {
      throw error;
    }

    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('[API] Failed to start agent:', error);
    
    if (
      error instanceof TypeError &&
      error.message.includes('Failed to fetch')
    ) {
      const networkError = new Error(
        `Cannot connect to backend server. Please check your internet connection and make sure the backend is running.`,
      );
      handleApiError(networkError, { operation: 'start agent', resource: 'AI assistant' });
      throw networkError;
    }

    handleApiError(error, { operation: 'start agent', resource: 'AI assistant' });
    throw error;
  }
};

export const stopAgent = async (agentRunId: string): Promise<void> => {
  nonRunningAgentRuns.add(agentRunId);

  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    existingStream.close();
    activeStreams.delete(agentRunId);
  }

  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    const authError = new NoAccessTokenAvailableError();
    handleApiError(authError, { operation: 'stop agent', resource: 'AI assistant' });
    throw authError;
  }

  const response = await fetch(`${API_URL}/agent-run/${agentRunId}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: 'no-store',
  });

  posthog.capture('task_abandoned', { agentRunId });

  if (!response.ok) {
    const stopError = new Error(`Error stopping agent: ${response.statusText}`);
    handleApiError(stopError, { operation: 'stop agent', resource: 'AI assistant' });
    throw stopError;
  }
};

export const getAgentStatus = async (agentRunId: string): Promise<AgentRun> => {
  if (nonRunningAgentRuns.has(agentRunId)) {
    throw new Error(`Agent run ${agentRunId} is not running`);
  }

  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      console.error('[API] No access token available for getAgentStatus');
      throw new NoAccessTokenAvailableError();
    }

    const url = `${API_URL}/agent-run/${agentRunId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `[API] Error getting agent status: ${response.status} ${response.statusText}`,
        errorText,
      );
      if (response.status === 404) {
        nonRunningAgentRuns.add(agentRunId);
      }

      throw new Error(
        `Error getting agent status: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    if (data.status !== 'running') {
      nonRunningAgentRuns.add(agentRunId);
    }

    return data;
  } catch (error) {
    console.error('[API] Failed to get agent status:', error);
    handleApiError(error, { operation: 'get agent status', resource: 'AI assistant status', silent: true });
    throw error;
  }
};

export interface AgentIconGenerationRequest {
  name: string;
  description?: string;
}

export interface AgentIconGenerationResponse {
  icon_name: string;
  icon_color: string;
  icon_background: string;
}

export const generateAgentIcon = async (request: AgentIconGenerationRequest): Promise<AgentIconGenerationResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/agents/generate-icon`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `[API] Error generating agent icon: ${response.status} ${response.statusText}`,
        errorText,
      );

      throw new Error(
        `Error generating agent icon: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[API] Failed to generate agent icon:', error);
    handleApiError(error, { operation: 'generate agent icon', resource: 'agent icon generation' });
    throw error;
  }
};

export const getAgentRuns = async (threadId: string): Promise<AgentRun[]> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/thread/${threadId}/agent-runs`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Error getting agent runs: ${response.statusText}`);
    }

    const data = await response.json();
    return data.agent_runs || [];
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get agent runs:', error);
    handleApiError(error, { operation: 'load agent runs', resource: 'conversation history' });
    throw error;
  }
};

export interface ActiveAgentRun {
  id: string;
  thread_id: string;
  status: 'running';
  started_at: string;
}

export const getActiveAgentRuns = async (): Promise<ActiveAgentRun[]> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/agent-runs/active`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Error getting active agent runs: ${response.statusText}`);
    }

    const data = await response.json();
    return data.active_runs || [];
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get active agent runs:', error);
    handleApiError(error, { operation: 'get active agent runs', resource: 'active agent runs', silent: true });
    throw error;
  }
};

export const streamAgent = (
  agentRunId: string,
  callbacks: {
    onMessage: (content: string) => void;
    onError: (error: Error | string) => void;
    onClose: () => void;
  },
): (() => void) => {
  if (nonRunningAgentRuns.has(agentRunId)) {
    setTimeout(() => {
      callbacks.onError(`Agent run ${agentRunId} is not running`);
      callbacks.onClose();
    }, 0);

    return () => {};
  }

  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    cleanupEventSource(agentRunId, 'replacing existing stream');
  }

  try {
    const setupStream = async () => {
      try {
        const status = await getAgentStatus(agentRunId);
        if (status.status !== 'running') {
          nonRunningAgentRuns.add(agentRunId);
          callbacks.onError(
            `Agent run ${agentRunId} is not running (status: ${status.status})`,
          );
          callbacks.onClose();
          return;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');

        if (isNotFoundError) {
          nonRunningAgentRuns.add(agentRunId);
        }

        callbacks.onError(errorMessage);
        callbacks.onClose();
        return;
      }

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        const authError = new NoAccessTokenAvailableError();
        callbacks.onError(authError);
        callbacks.onClose();
        return;
      }

      const url = new URL(`${API_URL}/agent-run/${agentRunId}/stream`);
      url.searchParams.append('token', session.access_token);

      const eventSource = new EventSource(url.toString());

      activeStreams.set(agentRunId, eventSource);

      eventSource.onopen = () => {
        console.log(`[STREAM] EventSource opened for ${agentRunId}`);
      };

      eventSource.onmessage = (event) => {
        try {
          const rawData = event.data;
          if (rawData.includes('"type": "ping"')) return;

          // Skip empty messages
          if (!rawData || rawData.trim() === '') {
            return;
          }

          // Check for error status messages
          try {
            const jsonData = JSON.parse(rawData);
            if (jsonData.status === 'error') {
              console.error(`[STREAM] Error status received for ${agentRunId}:`, jsonData);
              
              // Pass the error message to the callback
              callbacks.onError(jsonData.message || 'Unknown error occurred');
              
              // Don't close the stream for error status messages as they may continue
              return;
            }
          } catch (jsonError) {
            // Not JSON or invalid JSON, continue with normal processing
          }

          // Check for "Agent run not found" error
          if (
            rawData.includes('Agent run') &&
            rawData.includes('not found in active runs')
          ) {
            // Add to non-running set to prevent future reconnection attempts
            nonRunningAgentRuns.add(agentRunId);

            // Notify about the error
            callbacks.onError('Agent run not found in active runs');

            // Clean up
            cleanupEventSource(agentRunId, 'agent run not found');
            callbacks.onClose();

            return;
          }

          // Check for completion messages
          if (
            rawData.includes('"type": "status"') &&
            rawData.includes('"status": "completed"')
          ) {
            // Check for specific completion messages that indicate we should stop checking
            if (rawData.includes('Agent run completed successfully')) {
              // Add to non-running set to prevent future reconnection attempts
              nonRunningAgentRuns.add(agentRunId);
            }

            // Notify about the message
            callbacks.onMessage(rawData);

            // Clean up
            cleanupEventSource(agentRunId, 'agent run completed');
            callbacks.onClose();

            return;
          }

          // Check for thread run end message
          if (
            rawData.includes('"type": "status"') &&
            rawData.includes('thread_run_end')
          ) {
            // Notify about the message
            callbacks.onMessage(rawData);
            return;
          }

          // For all other messages, just pass them through
          callbacks.onMessage(rawData);
        } catch (error) {
          console.error(`[STREAM] Error handling message:`, error);
          callbacks.onError(error instanceof Error ? error : String(error));
        }
      };

      eventSource.onerror = (event) => {
        console.error(`[STREAM] EventSource error for ${agentRunId}:`, event);
        
        // Check if the agent is still running
        getAgentStatus(agentRunId)
          .then((status) => {
            if (status.status !== 'running') {
              nonRunningAgentRuns.add(agentRunId);
              cleanupEventSource(agentRunId, 'agent not running');
              callbacks.onClose();
            } else {
              // Let the browser handle reconnection for non-fatal errors
            }
          })
          .catch((err) => {
            console.error(
              `[STREAM] Error checking agent status after stream error:`,
              err,
            );

            // Check if this is a "not found" error
            const errMsg = err instanceof Error ? err.message : String(err);
            const isNotFoundErr =
              errMsg.includes('not found') ||
              errMsg.includes('404') ||
              errMsg.includes('does not exist');

            if (isNotFoundErr) {
              nonRunningAgentRuns.add(agentRunId);
              cleanupEventSource(agentRunId, 'agent not found');
              callbacks.onClose();
            } else {
              // For other errors, still clean up the stream to prevent memory leaks
              // but don't add to nonRunningAgentRuns as it might be a temporary network issue
              console.warn(`[STREAM] Cleaning up stream for ${agentRunId} due to persistent error`);
              cleanupEventSource(agentRunId, 'persistent error');
              callbacks.onError(errMsg);
              callbacks.onClose();
            }
          });
      };
    };

    // Start the stream setup
    setupStream();

    // Return a cleanup function
    return () => {
      cleanupEventSource(agentRunId, 'manual cleanup');
    };
  } catch (error) {
    console.error(`[STREAM] Error setting up stream for ${agentRunId}:`, error);
    callbacks.onError(error instanceof Error ? error : String(error));
    callbacks.onClose();
    return () => {};
  }
};

// Sandbox API Functions
export const createSandboxFile = async (
  sandboxId: string,
  filePath: string,
  content: string,
): Promise<void> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // Use FormData to handle both text and binary content more reliably
    const formData = new FormData();
    formData.append('path', filePath);

    // Create a Blob from the content string and append as a file
    const blob = new Blob([content], { type: 'application/octet-stream' });
    formData.append('file', blob, filePath.split('/').pop() || 'file');

    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error creating sandbox file: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error creating sandbox file: ${response.statusText} (${response.status})`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Failed to create sandbox file:', error);
    handleApiError(error, { operation: 'create file', resource: `file ${filePath}` });
    throw error;
  }
};

// Fallback method for legacy support using JSON
export const createSandboxFileJson = async (
  sandboxId: string,
  filePath: string,
  content: string,
): Promise<void> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(
      `${API_URL}/sandboxes/${sandboxId}/files/json`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: filePath,
          content: content,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error creating sandbox file (JSON): ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error creating sandbox file: ${response.statusText} (${response.status})`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Failed to create sandbox file with JSON:', error);
    handleApiError(error, { operation: 'create file', resource: `file ${filePath}` });
    throw error;
  }
};

// Helper function to normalize file paths with Unicode characters
function normalizePathWithUnicode(path: string): string {
  try {
    // Replace escaped Unicode sequences with actual characters
    return path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
      return String.fromCharCode(parseInt(hexCode, 16));
    });
  } catch (e) {
    console.error('Error processing Unicode escapes in path:', e);
    return path;
  }
}

export const listSandboxFiles = async (
  sandboxId: string,
  path: string,
): Promise<FileInfo[]> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files`);
    
    // Normalize the path to handle Unicode escape sequences
    const normalizedPath = normalizePathWithUnicode(path);
    
    // Properly encode the path parameter for UTF-8 support
    url.searchParams.append('path', normalizedPath);

    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url.toString(), {
      headers,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error listing sandbox files: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error listing sandbox files: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    return data.files || [];
  } catch (error) {
    console.error('Failed to list sandbox files:', error);
    // handleApiError(error, { operation: 'list files', resource: `directory ${path}` });
    throw error;
  }
};

export const getSandboxFileContent = async (
  sandboxId: string,
  path: string,
): Promise<string | Blob> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files/content`);
    
    // Normalize the path to handle Unicode escape sequences
    const normalizedPath = normalizePathWithUnicode(path);
    
    // Properly encode the path parameter for UTF-8 support
    url.searchParams.append('path', normalizedPath);

    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url.toString(), {
      headers,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error getting sandbox file content: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error getting sandbox file content: ${response.statusText} (${response.status})`,
      );
    }

    // Check if it's a text file or binary file based on content-type
    const contentType = response.headers.get('content-type');
    if (
      (contentType && contentType.includes('text')) ||
      contentType?.includes('application/json')
    ) {
      return await response.text();
    } else {
      return await response.blob();
    }
  } catch (error) {
    console.error('Failed to get sandbox file content:', error);
    handleApiError(error, { operation: 'load file content', resource: `file ${path}` });
    throw error;
  }
};

// Function to get public projects
export const getPublicProjects = async (): Promise<Project[]> => {
  try {
    const supabase = createClient();

    // Query for threads that are marked as public
    const { data: publicThreads, error: threadsError } = await supabase
      .from('threads')
      .select('project_id')
      .eq('is_public', true);

    if (threadsError) {
      console.error('Error fetching public threads:', threadsError);
      return [];
    }

    // If no public threads found, return empty array
    if (!publicThreads?.length) {
      return [];
    }

    // Extract unique project IDs from public threads
    const publicProjectIds = [
      ...new Set(publicThreads.map((thread) => thread.project_id)),
    ].filter(Boolean);

    // If no valid project IDs, return empty array
    if (!publicProjectIds.length) {
      return [];
    }

    // Get the projects that have public threads
    const { data: projects, error: projectsError } = await supabase
      .from('projects')
      .select('*')
      .in('project_id', publicProjectIds);

    if (projectsError) {
      console.error('Error fetching public projects:', projectsError);
      return [];
    }

    // Map database fields to our Project type
    const mappedProjects: Project[] = (projects || []).map((project) => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
      is_public: true, // Mark these as public projects
    }));

    return mappedProjects;
  } catch (err) {
    console.error('Error fetching public projects:', err);
    handleApiError(err, { operation: 'load public projects', resource: 'public projects' });
    return [];
  }
};


export const initiateAgent = async (
  formData: FormData,
): Promise<InitiateAgentResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    if (!API_URL) {
      throw new Error(
        'Backend URL is not configured. Set NEXT_PUBLIC_BACKEND_URL in your environment.',
      );
    }

    const response = await fetch(`${API_URL}/agent/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: formData,
      cache: 'no-store',
    });

    if (!response.ok) {
      // Check for 402 Payment Required first
      if (response.status === 402) {
        try {
          const errorData = await response.json();
          // Ensure detail exists and has a message property
          const detail = errorData?.detail || { message: 'Payment Required' };
          if (typeof detail.message !== 'string') {
            detail.message = 'Payment Required'; // Default message if missing
          }
          throw new BillingError(response.status, detail);
        } catch (parseError) {
          // Handle cases where parsing fails or the structure isn't as expected
          throw new BillingError(
            response.status,
            { message: 'Payment Required' },
            `Error initiating agent: ${response.statusText} (402)`,
          );
        }
      }

      // Check for 429 Too Many Requests (Agent Run Limit)
      if (response.status === 429) {
          const errorData = await response.json();
          // Ensure detail exists and has required properties
          const detail = errorData?.detail || { 
            message: 'Too many agent runs running',
            running_thread_ids: [],
            running_count: 0,
          };
          if (typeof detail.message !== 'string') {
            detail.message = 'Too many agent runs running';
          }
          if (!Array.isArray(detail.running_thread_ids)) {
            detail.running_thread_ids = [];
          }
          if (typeof detail.running_count !== 'number') {
            detail.running_count = 0;
          }
          throw new AgentRunLimitError(response.status, detail);
      }

      // Handle other errors
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      
      console.error(
        `[API] Error initiating agent: ${response.status} ${response.statusText}`,
        errorText,
      );
    
      if (response.status === 401) {
        throw new Error('Authentication error: Please sign in again');
      } else if (response.status >= 500) {
        throw new Error('Server error: Please try again later');
      }
    
      throw new Error(
        `Error initiating agent: ${response.statusText} (${response.status})`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    // Rethrow BillingError and AgentRunLimitError instances directly
    if (error instanceof BillingError || error instanceof AgentRunLimitError) {
      throw error;
    }

    console.error('[API] Failed to initiate agent:', error);

    if (
      error instanceof TypeError &&
      error.message.includes('Failed to fetch')
    ) {
      const networkError = new Error(
        `Cannot connect to backend server. Please check your internet connection and make sure the backend is running.`,
      );
      handleApiError(networkError, { operation: 'initiate agent', resource: 'AI assistant' });
      throw networkError;
    }
    handleApiError(error, { operation: 'initiate agent' });
    throw error;
  }
};

export const checkApiHealth = async (): Promise<HealthCheckResponse> => {
  try {
    const response = await fetch(`${API_URL}/health`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`API health check failed: ${response.statusText}`);
    }

    return response.json();
  } catch (error) {
    throw error;
  }
};

// Billing API Types
export interface CreateCheckoutSessionRequest {
  price_id: string;
  success_url: string;
  cancel_url: string;
  referral_id?: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
}

export interface CreatePortalSessionRequest {
  return_url: string;
}

export interface SubscriptionStatus {
  status: string; // Includes 'active', 'trialing', 'past_due', 'scheduled_downgrade', 'no_subscription'
  plan_name?: string;
  price_id?: string;
  current_period_end?: string; // ISO datetime string
  cancel_at_period_end?: boolean;
  trial_end?: string; // ISO datetime string
  minutes_limit?: number;
  cost_limit?: number;
  current_usage?: number;
  // Fields for scheduled changes
  has_schedule?: boolean;
  scheduled_plan_name?: string;
  scheduled_price_id?: string;
  scheduled_change_date?: string; // ISO datetime string
  // Subscription data for frontend components
  subscription_id?: string;
  subscription?: {
    id: string;
    status: string;
    cancel_at_period_end: boolean;
    cancel_at?: number; // timestamp for yearly commitment cancellations
    current_period_end: number; // timestamp
  };
  // Credit information
  credit_balance?: number;
  can_purchase_credits?: boolean;
  tier?: {
    name: string;
    credits: number;
    can_purchase_credits: boolean;
    models?: string[];
    project_limit?: number;
  };
}

export interface CommitmentInfo {
  has_commitment: boolean;
  commitment_type?: string;
  months_remaining?: number;
  can_cancel: boolean;
  commitment_end_date?: string;
}

// Interface for user subscription details from Stripe
export interface UserSubscriptionResponse {
  subscription?: {
    id: string;
    status: string;
    current_period_end: number;
    current_period_start: number;
    cancel_at_period_end: boolean;
    cancel_at?: number;
    items: {
      data: Array<{
        id: string;
        price: {
          id: string;
          unit_amount: number;
          currency: string;
          recurring: {
            interval: string;
            interval_count: number;
          };
        };
        quantity: number;
      }>;
    };
    metadata: {
      [key: string]: string;
    };
  };
  price_id?: string;
  plan_name?: string;
  status?: string;
  has_schedule?: boolean;
  scheduled_price_id?: string;
  current_period_end?: number;
  current_period_start?: number;
  cancel_at_period_end?: boolean;
  cancel_at?: number;
  customer_email?: string;
  usage?: {
    total_usage: number;
    limit: number;
  };
}

// Usage log entry interface
export interface UsageLogEntry {
  message_id: string;
  thread_id: string;
  created_at: string;
  content: {
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
    };
    model: string;
  };
  total_tokens: number;
  estimated_cost: number | string;
  project_id: string;
  // Credit usage fields
  credit_used?: number;
  payment_method?: 'credits' | 'subscription';
  was_over_limit?: boolean;
}

// Usage logs response interface
export interface UsageLogsResponse {
  logs: UsageLogEntry[];
  has_more: boolean;
  total_count?: number;
}

export interface BillingStatusResponse {
  can_run: boolean;
  message: string;
  subscription: {
    price_id: string;
    plan_name: string;
    minutes_limit?: number;
  };
}

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

export interface CreateCheckoutSessionResponse {
  status:
    | 'upgraded'
    | 'downgrade_scheduled'
    | 'checkout_created'
    | 'no_change'
    | 'new'
    | 'updated'
    | 'scheduled'
    | 'commitment_created'
    | 'commitment_blocks_downgrade';
  subscription_id?: string;
  schedule_id?: string;
  session_id?: string;
  url?: string;
  effective_date?: string;
  message?: string;
  details?: {
    is_upgrade?: boolean;
    effective_date?: string;
    current_price?: number;
    new_price?: number;
    commitment_end_date?: string;
    months_remaining?: number;
    invoice?: {
      id: string;
      status: string;
      amount_due: number;
      amount_paid: number;
    };
  };
}

export interface CancelSubscriptionResponse {
  success: boolean;
  status: 'cancelled_at_period_end' | 'commitment_prevents_cancellation';
  message: string;
  details?: {
    subscription_id?: string;
    cancellation_effective_date?: string;
    current_period_end?: number;
    access_until?: string;
    months_remaining?: number;
    commitment_end_date?: string;
    can_cancel_after?: string;
  };
}

export interface ReactivateSubscriptionResponse {
  success: boolean;
  status: 'reactivated' | 'not_cancelled';
  message: string;
  details?: {
    subscription_id?: string;
    next_billing_date?: string;
  };
}

// Billing API Functions
export const createCheckoutSession = async (
  request: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }
    
    
    const requestBody = { ...request, tolt_referral: window.tolt_referral };
    
    // Use the new billing v2 API endpoint
    const response = await fetch(`${API_URL}/billing/create-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error creating checkout session: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error creating checkout session: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    if (data.checkout_url) {
      return {
        status: 'checkout_created',
        url: data.checkout_url
      };
    } else if (data.success && data.subscription_id) {
      return {
        status: 'updated',
        message: data.message || 'Subscription updated successfully',
        subscription_id: data.subscription_id
      };
    } else {
      return data;
    }
  } catch (error) {
    console.error('Failed to create checkout session:', error);
    handleApiError(error, { operation: 'create checkout session', resource: 'billing' });
    throw error;
  }
};


export const createPortalSession = async (
  request: CreatePortalSessionRequest,
): Promise<{ url: string }> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error creating portal session: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error creating portal session: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    
    return {
      url: data.portal_url
    };
  } catch (error) {
    console.error('Failed to create portal session:', error);
    handleApiError(error, { operation: 'create portal session', resource: 'billing portal' });
    throw error;
  }
};


export const getSubscription = async (): Promise<SubscriptionStatus> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/subscription`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error getting subscription: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error getting subscription: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();

    return {
      subscription: data.subscription ? {
        ...data.subscription,
        cancel_at_period_end: data.subscription.cancel_at ? true : false,
      } : null,
      current_usage: data.credits?.lifetime_used || 0,
      cost_limit: data.tier?.credits || 0,
      credit_balance: data.credits?.balance || 0,
      can_purchase_credits: data.credits?.can_purchase || false,
      ...data 
    } as SubscriptionStatus;
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get subscription:', error);
    handleApiError(error, { operation: 'load subscription', resource: 'billing information' });
    throw error;
  }
};

export const getSubscriptionCommitment = async (subscriptionId: string): Promise<CommitmentInfo> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    // Use the new billing v2 API endpoint
    const response = await fetch(`${API_URL}/billing/subscription-commitment/${subscriptionId}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error getting subscription commitment: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error getting subscription commitment: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get subscription commitment:', error);
    handleApiError(error, { operation: 'load subscription commitment', resource: 'commitment information' });
    throw error;
  }
};

export const getAvailableModels = async (): Promise<AvailableModelsResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/available-models`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error getting available models: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error getting available models: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get available models:', error);
    handleApiError(error, { operation: 'load available models', resource: 'AI models' });
    throw error;
  }
};

export const checkBillingStatus = async (): Promise<BillingStatusResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/check-status`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error checking billing status: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error checking billing status: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to check billing status:', error);
    throw error;
  }
};

export const cancelSubscription = async (): Promise<CancelSubscriptionResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/cancel-subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error cancelling subscription: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error cancelling subscription: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    handleApiError(error, { operation: 'cancel subscription', resource: 'subscription' });
    throw error;
  }
};

export const reactivateSubscription = async (): Promise<ReactivateSubscriptionResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const response = await fetch(`${API_URL}/billing/reactivate-subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error reactivating subscription: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error reactivating subscription: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    console.error('Failed to reactivate subscription:', error);
    handleApiError(error, { operation: 'reactivate subscription', resource: 'subscription' });
    throw error;
  }
};

// Transcription API Types
export interface TranscriptionResponse {
  text: string;
}

// Transcription API Functions
export const transcribeAudio = async (audioFile: File): Promise<TranscriptionResponse> => {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const formData = new FormData();
    formData.append('audio_file', audioFile);

    const response = await fetch(`${API_URL}/transcription`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `Error transcribing audio: ${response.status} ${response.statusText}`,
      );
      throw new Error(
        `Error transcribing audio: ${response.statusText} (${response.status})`,
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to transcribe audio:', error);
    handleApiError(error, { operation: 'transcribe audio', resource: 'speech-to-text' });
    throw error;
  }
};