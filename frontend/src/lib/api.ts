import { createClient } from '@/lib/supabase/client';
import { handleApiError } from './error-handler';

// Get backend URL from environment variables
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Set to keep track of agent runs that are known to be non-running
const nonRunningAgentRuns = new Set<string>();
// Map to keep track of active EventSource streams
const activeStreams = new Map<string, EventSource>();

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

export class NoAccessTokenAvailableError extends Error {
  constructor(message?: string, options?: { cause?: Error }) {
    super(message || 'No access token available', options);
  }
  name = 'NoAccessTokenAvailableError';
}

// Type Definitions (moved from potential separate file for clarity)
export type Project = {
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
  is_public?: boolean; // Flag to indicate if the project is public
  [key: string]: any; // Allow additional properties to handle database fields
};

export type Thread = {
  thread_id: string;
  account_id: string | null;
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
    avatar?: string;
    avatar_color?: string;
  };
};

export interface MessageWithFeedback extends Message {
  message_id: string;
  user_feedback?: boolean | null;
}

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

export type WorkflowExecution = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  started_at: string | null;
  completed_at: string | null;
  result: any;
  error: string | null;
};

export type WorkflowExecutionLog = {
  id: string;
  execution_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  input_data: any;
  output_data: any;
  error: string | null;
};

// Workflow Types
export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused' | 'disabled' | 'archived';
  project_id: string;
  account_id: string;
  definition: {
    name: string;
    description: string;
    nodes: any[];
    edges: any[];
    variables?: Record<string, any>;
  };
  created_at: string;
  updated_at: string;
};

export type WorkflowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: any;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
};

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
      console.log('[API] No user logged in, returning empty projects array');
      return [];
    }

    // Query only projects where account_id matches the current user's ID
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('account_id', userData.user.id);

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

    console.log('[API] Raw projects from DB:', data?.length, data);

    // Map database fields to our Project type
    const mappedProjects: Project[] = (data || []).map((project) => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      account_id: project.account_id,
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    }));

    console.log('[API] Mapped projects for frontend:', mappedProjects.length);

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

    console.log('Raw project data from database:', data);

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

          console.log(`Ensuring sandbox is active for project ${projectId}...`);
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
          } else {
            console.log('Sandbox activation successful');
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
      account_id: data.account_id,
      is_public: data.is_public || false,
      created_at: data.created_at,
      sandbox: data.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    };

    // console.log('Mapped project data for frontend:', mappedProject);

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
    account_id: data.account_id,
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

  console.log('Updating project with ID:', projectId);
  console.log('Update data:', data);

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
    account_id: updatedData.account_id,
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
    console.log('[API] No user logged in, returning empty threads array');
    return [];
  }

  let query = supabase.from('threads').select('*');

  // Always filter by the current user's account ID
  query = query.eq('account_id', userData.user.id);

  if (projectId) {
    console.log('[API] Filtering threads by project_id:', projectId);
    query = query.eq('project_id', projectId);
  }

  const { data, error } = await query;

  if (error) {
    handleApiError(error, { operation: 'load threads', resource: projectId ? `threads for project ${projectId}` : 'threads' });
    throw error;
  }

  const mappedThreads: Thread[] = (data || [])
    .filter((thread) => {
      const metadata = thread.metadata || {};
      return !metadata.is_agent_builder;
    })
    .map((thread) => ({
      thread_id: thread.thread_id,
      account_id: thread.account_id,
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

export const getMessages = async (threadId: string): Promise<MessageWithFeedback[]> => {
  const supabase = createClient();

  let allMessages: MessageWithFeedback[] = [];
  let from = 0;
  const batchSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('messages')
      .select(`
        *,
        agents:agent_id (
          name,
          avatar,
          avatar_color
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


  try {
    const messageIds = allMessages
      .filter((m: Message) => m.type === 'assistant')
      .map((m: any) => m.message_id)
      .filter((id) => Boolean(id));

    if (messageIds.length > 0) {
      const { data: feedbackData, error: feedbackError } = await supabase
        .from('feedback')
        .select('message_id, is_good')
        .in('message_id', messageIds);

      if (feedbackError) {
        console.error('Error fetching feedback data:', feedbackError);
      }
      
      const feedback = Object.fromEntries(
        feedbackData?.map((feedback: { message_id: string; is_good: boolean }) => [feedback.message_id, feedback.is_good]) ?? []
      );

      // Attach feedback to messages
      allMessages = allMessages.map((msg: MessageWithFeedback) => ({
        ...msg,
        user_feedback: feedback[msg.message_id] ?? null,
      }));
    }
  } catch (feedbackAttachError) {
    console.error('Failed to attach feedback metadata to messages:', feedbackAttachError);
  }

  console.log('[API] Messages fetched count:', allMessages.length);

  return allMessages;
};

// Agent APIs
export const startAgent = async (
  threadId: string,
  options?: {
    model_name?: string;
    enable_thinking?: boolean;
    reasoning_effort?: string;
    stream?: boolean;
    agent_id?: string;
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

    console.log(
      `[API] Starting agent for thread ${threadId} using ${API_URL}/thread/${threadId}/agent/start`,
    );

    const defaultOptions = {
      model_name: 'claude-3-7-sonnet-latest',
      enable_thinking: false,
      reasoning_effort: 'low',
      stream: true,
      agent_id: undefined,
    };

    const finalOptions = { ...defaultOptions, ...options };

    const body: any = {
      model_name: finalOptions.model_name,
      enable_thinking: finalOptions.enable_thinking,
      reasoning_effort: finalOptions.reasoning_effort,
      stream: finalOptions.stream,
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
      // Check for 402 Payment Required first
      if (response.status === 402) {
        try {
          const errorData = await response.json();
          console.error(`[API] Billing error starting agent (402):`, errorData);
          // Ensure detail exists and has a message property
          const detail = errorData?.detail || { message: 'Payment Required' };
          if (typeof detail.message !== 'string') {
            detail.message = 'Payment Required'; // Default message if missing
          }
          throw new BillingError(response.status, detail);
        } catch (parseError) {
          // Handle cases where parsing fails or the structure isn't as expected
          console.error(
            '[API] Could not parse 402 error response body:',
            parseError,
          );
          throw new BillingError(
            response.status,
            { message: 'Payment Required' },
            `Error starting agent: ${response.statusText} (402)`,
          );
        }
      }

      // Handle other errors
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      console.error(
        `[API] Error starting agent: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(
        `Error starting agent: ${response.statusText} (${response.status})`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    // Rethrow BillingError instances directly
    if (error instanceof BillingError) {
      throw error;
    }

    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('[API] Failed to start agent:', error);
    
    // Handle different error types with appropriate user messages
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

    // For other errors, add context and rethrow
    handleApiError(error, { operation: 'start agent', resource: 'AI assistant' });
    throw error;
  }
};

export const stopAgent = async (agentRunId: string): Promise<void> => {
  // Add to non-running set immediately to prevent reconnection attempts
  nonRunningAgentRuns.add(agentRunId);

  // Close any existing stream
  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    console.log(
      `[API] Closing existing stream for ${agentRunId} before stopping agent`,
    );
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
    // Add cache: 'no-store' to prevent caching
    cache: 'no-store',
  });

  if (!response.ok) {
    const stopError = new Error(`Error stopping agent: ${response.statusText}`);
    handleApiError(stopError, { operation: 'stop agent', resource: 'AI assistant' });
    throw stopError;
  }
};

export const getAgentStatus = async (agentRunId: string): Promise<AgentRun> => {
  console.log(`[API] Requesting agent status for ${agentRunId}`);

  // If we already know this agent is not running, throw an error
  if (nonRunningAgentRuns.has(agentRunId)) {
    console.log(
      `[API] Agent run ${agentRunId} is known to be non-running, returning error`,
    );
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
    console.log(`[API] Fetching from: ${url}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      // Add cache: 'no-store' to prevent caching
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

      // If we get a 404, add to non-running set
      if (response.status === 404) {
        nonRunningAgentRuns.add(agentRunId);
      }

      throw new Error(
        `Error getting agent status: ${response.statusText} (${response.status})`,
      );
    }

    const data = await response.json();
    console.log(`[API] Successfully got agent status:`, data);

    // If agent is not running, add to non-running set
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
      // Add cache: 'no-store' to prevent caching
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

export const streamAgent = (
  agentRunId: string,
  callbacks: {
    onMessage: (content: string) => void;
    onError: (error: Error | string) => void;
    onClose: () => void;
  },
): (() => void) => {
  console.log(`[STREAM] streamAgent called for ${agentRunId}`);

  // Check if this agent run is known to be non-running
  if (nonRunningAgentRuns.has(agentRunId)) {
    console.log(
      `[STREAM] Agent run ${agentRunId} is known to be non-running, not creating stream`,
    );
    // Notify the caller immediately
    setTimeout(() => {
      callbacks.onError(`Agent run ${agentRunId} is not running`);
      callbacks.onClose();
    }, 0);

    // Return a no-op cleanup function
    return () => {};
  }

  // Check if there's already an active stream for this agent run
  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    console.log(
      `[STREAM] Stream already exists for ${agentRunId}, closing it first`,
    );
    existingStream.close();
    activeStreams.delete(agentRunId);
  }

  // Set up a new stream
  try {
    const setupStream = async () => {
      // First verify the agent is actually running
      try {
        const status = await getAgentStatus(agentRunId);
        if (status.status !== 'running') {
          console.log(
            `[STREAM] Agent run ${agentRunId} is not running (status: ${status.status}), not creating stream`,
          );
          nonRunningAgentRuns.add(agentRunId);
          callbacks.onError(
            `Agent run ${agentRunId} is not running (status: ${status.status})`,
          );
          callbacks.onClose();
          return;
        }
      } catch (err) {
        console.error(`[STREAM] Error verifying agent run ${agentRunId}:`, err);

        // Check if this is a "not found" error
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');

        if (isNotFoundError) {
          console.log(
            `[STREAM] Agent run ${agentRunId} not found, not creating stream`,
          );
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
        console.error('[STREAM] No auth token available');
        callbacks.onError(authError);
        callbacks.onClose();
        return;
      }

      const url = new URL(`${API_URL}/agent-run/${agentRunId}/stream`);
      url.searchParams.append('token', session.access_token);

      console.log(`[STREAM] Creating EventSource for ${agentRunId}`);
      const eventSource = new EventSource(url.toString());

      // Store the EventSource in the active streams map
      activeStreams.set(agentRunId, eventSource);

      eventSource.onopen = () => {
        console.log(`[STREAM] Connection opened for ${agentRunId}`);
      };

      eventSource.onmessage = (event) => {
        try {
          const rawData = event.data;
          if (rawData.includes('"type":"ping"')) return;

          // Log raw data for debugging (truncated for readability)
          console.log(
            `[STREAM] Received data for ${agentRunId}: ${rawData.substring(0, 100)}${rawData.length > 100 ? '...' : ''}`,
          );

          // Skip empty messages
          if (!rawData || rawData.trim() === '') {
            console.debug('[STREAM] Received empty message, skipping');
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
            console.log(
              `[STREAM] Agent run ${agentRunId} not found in active runs, closing stream`,
            );

            // Add to non-running set to prevent future reconnection attempts
            nonRunningAgentRuns.add(agentRunId);

            // Notify about the error
            callbacks.onError('Agent run not found in active runs');

            // Clean up
            eventSource.close();
            activeStreams.delete(agentRunId);
            callbacks.onClose();

            return;
          }

          // Check for completion messages
          if (
            rawData.includes('"type":"status"') &&
            rawData.includes('"status":"completed"')
          ) {
            console.log(
              `[STREAM] Detected completion status message for ${agentRunId}`,
            );

            // Check for specific completion messages that indicate we should stop checking
            if (
              rawData.includes('Run data not available for streaming') ||
              rawData.includes('Stream ended with status: completed')
            ) {
              console.log(
                `[STREAM] Detected final completion message for ${agentRunId}, adding to non-running set`,
              );
              // Add to non-running set to prevent future reconnection attempts
              nonRunningAgentRuns.add(agentRunId);
            }

            // Notify about the message
            callbacks.onMessage(rawData);

            // Clean up
            eventSource.close();
            activeStreams.delete(agentRunId);
            callbacks.onClose();

            return;
          }

          // Check for thread run end message
          if (
            rawData.includes('"type":"status"') &&
            rawData.includes('"status_type":"thread_run_end"')
          ) {
            console.log(
              `[STREAM] Detected thread run end message for ${agentRunId}`,
            );

            // Add to non-running set
            nonRunningAgentRuns.add(agentRunId);

            // Notify about the message
            callbacks.onMessage(rawData);

            // Clean up
            eventSource.close();
            activeStreams.delete(agentRunId);
            callbacks.onClose();

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
        console.log(`[STREAM] EventSource error for ${agentRunId}:`, event);

        // Check if the agent is still running
        getAgentStatus(agentRunId)
          .then((status) => {
            if (status.status !== 'running') {
              console.log(
                `[STREAM] Agent run ${agentRunId} is not running after error, closing stream`,
              );
              nonRunningAgentRuns.add(agentRunId);
              eventSource.close();
              activeStreams.delete(agentRunId);
              callbacks.onClose();
            } else {
              console.log(
                `[STREAM] Agent run ${agentRunId} is still running after error, keeping stream open`,
              );
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
              console.log(
                `[STREAM] Agent run ${agentRunId} not found after error, closing stream`,
              );
              nonRunningAgentRuns.add(agentRunId);
              eventSource.close();
              activeStreams.delete(agentRunId);
              callbacks.onClose();
            }

            // For other errors, notify but don't close the stream
            callbacks.onError(errMsg);
          });
      };
    };

    // Start the stream setup
    setupStream();

    // Return a cleanup function
    return () => {
      console.log(`[STREAM] Cleanup called for ${agentRunId}`);
      const stream = activeStreams.get(agentRunId);
      if (stream) {
        console.log(`[STREAM] Closing stream for ${agentRunId}`);
        stream.close();
        activeStreams.delete(agentRunId);
      }
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

    console.log(
      '[API] Raw public projects from DB:',
      projects?.length,
      projects,
    );

    // Map database fields to our Project type
    const mappedProjects: Project[] = (projects || []).map((project) => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      account_id: project.account_id,
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

    console.log(
      '[API] Mapped public projects for frontend:',
      mappedProjects.length,
    );

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

    console.log(
      `[API] Initiating agent with files using ${API_URL}/agent/initiate`,
    );

    const response = await fetch(`${API_URL}/agent/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: formData,
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'No error details available');
      
      console.error(
        `[API] Error initiating agent: ${response.status} ${response.statusText}`,
        errorText,
      );
    
      if (response.status === 402) {
        throw new Error('Payment Required');
      } else if (response.status === 401) {
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
}

export interface CreatePortalSessionRequest {
  return_url: string;
}

export interface SubscriptionStatus {
  status: string; // Includes 'active', 'trialing', 'past_due', 'scheduled_downgrade', 'no_subscription'
  plan_name?: string;
  price_id?: string; // Added
  current_period_end?: string; // ISO Date string
  cancel_at_period_end: boolean;
  trial_end?: string; // ISO Date string
  minutes_limit?: number;
  cost_limit?: number;
  current_usage?: number;
  // Fields for scheduled changes
  has_schedule: boolean;
  scheduled_plan_name?: string;
  scheduled_price_id?: string; // Added
  scheduled_change_date?: string; // ISO Date string - Deprecate? Check backend usage
  schedule_effective_date?: string; // ISO Date string - Added for consistency
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
}

export interface AvailableModelsResponse {
  models: Model[];
  subscription_tier: string;
  total_models: number;
}

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
  estimated_cost: number;
  project_id: string;
}

export interface UsageLogsResponse {
  logs: UsageLogEntry[];
  has_more: boolean;
  message?: string;
}

export interface CreateCheckoutSessionResponse {
  status:
    | 'upgraded'
    | 'downgrade_scheduled'
    | 'checkout_created'
    | 'no_change'
    | 'new'
    | 'updated'
    | 'scheduled';
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
    invoice?: {
      id: string;
      status: string;
      amount_due: number;
      amount_paid: number;
    };
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
    console.log('Tolt Referral ID:', requestBody.tolt_referral);
    
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
    console.log('Checkout session response:', data);

    // Handle all possible statuses
    switch (data.status) {
      case 'upgraded':
      case 'updated':
      case 'downgrade_scheduled':
      case 'scheduled':
      case 'no_change':
        return data;
      case 'new':
      case 'checkout_created':
        if (!data.url) {
          throw new Error('No checkout URL provided');
        }
        return data;
      default:
        console.warn(
          'Unexpected status from createCheckoutSession:',
          data.status,
        );
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

    return response.json();
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

    return response.json();
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    console.error('Failed to get subscription:', error);
    handleApiError(error, { operation: 'load subscription', resource: 'billing information' });
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
        errorText,
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

export const getAgentBuilderChatHistory = async (agentId: string): Promise<{messages: Message[], thread_id: string | null}> => {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new NoAccessTokenAvailableError();
  }

  const response = await fetch(`${API_URL}/agents/${agentId}/builder-chat-history`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'No error details available');
    console.error(`Error getting agent builder chat history: ${response.status} ${response.statusText}`, errorText);
    throw new Error(`Error getting agent builder chat history: ${response.statusText}`);
  }

  const data = await response.json();
  console.log('[API] Agent builder chat history fetched:', data);

  return data;
};
