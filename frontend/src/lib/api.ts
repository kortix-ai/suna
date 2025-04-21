import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Track active streams by agent run ID
const activeStreams = new Map<string, EventSource>();

// Track agent runs that have been confirmed as completed or not found
const nonRunningAgentRuns = new Set<string>();

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
}

export type Thread = {
  thread_id: string;
  account_id: string | null;
  project_id?: string | null;
  is_public?: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: any; // Allow additional properties to handle database fields
}

export type Message = {
  role: string;
  content: string;
  type: string;
}

export type AgentRun = {
  id: string;
  thread_id: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  started_at: string;
  completed_at: string | null;
  responses: Message[];
  error: string | null;
}

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
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
      if (error.code === '42501' && error.message.includes('has_role_on_account')) {
        console.error('Permission error: User does not have proper account access');
        return []; // Return empty array instead of throwing
      }
      throw error;
    }
    
    console.log('[API] Raw projects from DB:', data?.length, data);
    
    // Map database fields to our Project type 
    const mappedProjects: Project[] = (data || []).map(project => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      account_id: project.account_id,
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || { id: "", pass: "", vnc_preview: "", sandbox_url: "" }
    }));
    
    console.log('[API] Mapped projects for frontend:', mappedProjects.length);
    
    return mappedProjects;
  } catch (err) {
    console.error('Error fetching projects:', err);
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
      try {
        const { data: { session } } = await supabase.auth.getSession();
        
        // For public projects, we don't need authentication
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`;
        }
        
        console.log(`Ensuring sandbox is active for project ${projectId}...`);
        const response = await fetch(`${API_URL}/project/${projectId}/sandbox/ensure-active`, {
          method: 'POST',
          headers,
        });
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => 'No error details available');
          console.warn(`Failed to ensure sandbox is active: ${response.status} ${response.statusText}`, errorText);
        } else {
          console.log('Sandbox activation successful');
        }
      } catch (sandboxError) {
        console.warn('Failed to ensure sandbox is active:', sandboxError);
        // Non-blocking error - continue with the project data
      }
    }
    
    // Map database fields to our Project type
    const mappedProject: Project = {
      id: data.project_id,
      name: data.name || '',
      description: data.description || '',
      account_id: data.account_id,
      created_at: data.created_at,
      sandbox: data.sandbox || { id: "", pass: "", vnc_preview: "", sandbox_url: "" }
    };
    
    console.log('Mapped project data for frontend:', mappedProject);
    
    return mappedProject;
  } catch (error) {
    console.error(`Error fetching project ${projectId}:`, error);
    throw error;
  }
};

export const createProject = async (
  projectData: { name: string; description: string }, 
  accountId?: string
): Promise<Project> => {
  const supabase = createClient();
  
  // If accountId is not provided, we'll need to get the user's ID
  if (!accountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    
    if (userError) throw userError;
    if (!userData.user) throw new Error('You must be logged in to create a project');
    
    // In Basejump, the personal account ID is the same as the user ID
    accountId = userData.user.id;
  }
  
  const { data, error } = await supabase
    .from('projects')
    .insert({ 
      name: projectData.name, 
      description: projectData.description || null,
      account_id: accountId
    })
    .select()
    .single();
  
  if (error) throw error;
  
  // Map the database response to our Project type
  return {
    id: data.project_id,
    name: data.name,
    description: data.description || '',
    account_id: data.account_id,
    created_at: data.created_at,
    sandbox: { id: "", pass: "", vnc_preview: "" }
  };
};

export const updateProject = async (projectId: string, data: Partial<Project>): Promise<Project> => {
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
    throw error;
  }
  
  if (!updatedData) {
    throw new Error('No data returned from update');
  }
  
  // Dispatch a custom event to notify components about the project change
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('project-updated', { 
      detail: { 
        projectId, 
        updatedData: {
          id: updatedData.project_id,
          name: updatedData.name,
          description: updatedData.description
        }
      } 
    }));
  }
  
  // Return formatted project data - use same mapping as getProject
  return {
    id: updatedData.project_id,
    name: updatedData.name,
    description: updatedData.description || '',
    account_id: updatedData.account_id,
    created_at: updatedData.created_at,
    sandbox: updatedData.sandbox || { id: "", pass: "", vnc_preview: "", sandbox_url: "" }
  };
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const supabase = createClient();
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('project_id', projectId);
  
  if (error) throw error;
};

// Thread APIs
export const getThreads = async (projectId?: string): Promise<Thread[]> => {
  const supabase = createClient();
  let query = supabase.from('threads').select('*');
  
  if (projectId) {
    console.log('[API] Filtering threads by project_id:', projectId);
    query = query.eq('project_id', projectId);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('[API] Error fetching threads:', error);
    throw error;
  }
  
  console.log('[API] Raw threads from DB:', data?.length, data);
  
  // Map database fields to ensure consistency with our Thread type
  const mappedThreads: Thread[] = (data || []).map(thread => ({
    thread_id: thread.thread_id,
    account_id: thread.account_id,
    project_id: thread.project_id,
    created_at: thread.created_at,
    updated_at: thread.updated_at
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
  
  if (error) throw error;
  
  return data;
};

export const createThread = async (projectId: string): Promise<Thread> => {
  const supabase = createClient();
  
  // If user is not logged in, redirect to login
  const { data: { user } } = await supabase.auth.getUser();
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
  
  if (error) throw error;
  
  return data;
};

export const addUserMessage = async (threadId: string, content: string): Promise<void> => {
  const supabase = createClient();
  
  // Format the message in the format the LLM expects - keep it simple with only required fields
  const message = {
    role: 'user',
    content: content
  };
  
  // Insert the message into the messages table
  const { error } = await supabase
    .from('messages')
    .insert({
      thread_id: threadId,
      type: 'user',
      is_llm_message: true,
      content: JSON.stringify(message)
    });
  
  if (error) {
    console.error('Error adding user message:', error);
    throw new Error(`Error adding message: ${error.message}`);
  }
};

export const getMessages = async (threadId: string): Promise<Message[]> => {
  const supabase = createClient();
  
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('thread_id', threadId)
    .neq('type', 'cost')
    .neq('type', 'summary')
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error('Error fetching messages:', error);
    throw new Error(`Error getting messages: ${error.message}`);
  }

  console.log('[API] Messages fetched:', data);
  
  return data || [];
};

// Agent APIs
export const startAgent = async (
  threadId: string, 
  options?: {
    model_name?: string;
    enable_thinking?: boolean;
    reasoning_effort?: string;
    stream?: boolean;
  }
): Promise<{ agent_run_id: string }> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    // Check if backend URL is configured
    if (!API_URL) {
      throw new Error('Backend URL is not configured. Set NEXT_PUBLIC_BACKEND_URL in your environment.');
    }

    console.log(`[API] Starting agent for thread ${threadId} using ${API_URL}/thread/${threadId}/agent/start`);
    
    const response = await fetch(`${API_URL}/thread/${threadId}/agent/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      // Add cache: 'no-store' to prevent caching
      cache: 'no-store',
      // Add the body, stringifying the options or an empty object
      body: JSON.stringify(options || {}),
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`[API] Error starting agent: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error starting agent: ${response.statusText} (${response.status})`);
    }
    
    return response.json();
  } catch (error) {
    console.error('[API] Failed to start agent:', error);
    
    // Provide clearer error message for network errors
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      throw new Error(`Cannot connect to backend server. Please check your internet connection and make sure the backend is running.`);
    }
    
    throw error;
  }
};

export const stopAgent = async (agentRunId: string): Promise<void> => {
  // Add to non-running set immediately to prevent reconnection attempts
  nonRunningAgentRuns.add(agentRunId);
  
  // Close any existing stream
  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    console.log(`[API] Closing existing stream for ${agentRunId} before stopping agent`);
    existingStream.close();
    activeStreams.delete(agentRunId);
  }
  
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    throw new Error('No access token available');
  }

  const response = await fetch(`${API_URL}/agent-run/${agentRunId}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    // Add cache: 'no-store' to prevent caching
    cache: 'no-store',
  });
  
  if (!response.ok) {
    throw new Error(`Error stopping agent: ${response.statusText}`);
  }
};

export const getAgentStatus = async (agentRunId: string): Promise<AgentRun> => {
  console.log(`[API] Requesting agent status for ${agentRunId}`);
  
  // If we already know this agent is not running, throw an error
  if (nonRunningAgentRuns.has(agentRunId)) {
    console.log(`[API] Agent run ${agentRunId} is known to be non-running, returning error`);
    throw new Error(`Agent run ${agentRunId} is not running`);
  }
  
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('[API] No access token available for getAgentStatus');
      throw new Error('No access token available');
    }

    const url = `${API_URL}/agent-run/${agentRunId}`;
    console.log(`[API] Fetching from: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
      // Add cache: 'no-store' to prevent caching
      cache: 'no-store',
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`[API] Error getting agent status: ${response.status} ${response.statusText}`, errorText);
      
      // If we get a 404, add to non-running set
      if (response.status === 404) {
        nonRunningAgentRuns.add(agentRunId);
      }
      
      throw new Error(`Error getting agent status: ${response.statusText} (${response.status})`);
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
    throw error;
  }
};

export const getAgentRuns = async (threadId: string): Promise<AgentRun[]> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    const response = await fetch(`${API_URL}/thread/${threadId}/agent-runs`, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
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
    console.error('Failed to get agent runs:', error);
    throw error;
  }
};

export const streamAgent = (agentRunId: string, callbacks: {
  onMessage: (content: string) => void;
  onError: (error: Error | string) => void;
  onClose: () => void;
}): () => void => {
  console.log(`[STREAM] streamAgent called for ${agentRunId}`);
  
  // Check if this agent run is known to be non-running
  if (nonRunningAgentRuns.has(agentRunId)) {
    console.log(`[STREAM] Agent run ${agentRunId} is known to be non-running, not creating stream`);
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
    console.log(`[STREAM] Stream already exists for ${agentRunId}, closing it first`);
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
          console.log(`[STREAM] Agent run ${agentRunId} is not running (status: ${status.status}), not creating stream`);
          nonRunningAgentRuns.add(agentRunId);
          callbacks.onError(`Agent run ${agentRunId} is not running (status: ${status.status})`);
          callbacks.onClose();
          return;
        }
      } catch (err) {
        console.error(`[STREAM] Error verifying agent run ${agentRunId}:`, err);
        
        // Check if this is a "not found" error
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isNotFoundError = errorMessage.includes('not found') || 
                               errorMessage.includes('404') || 
                               errorMessage.includes('does not exist');
        
        if (isNotFoundError) {
          console.log(`[STREAM] Agent run ${agentRunId} not found, not creating stream`);
          nonRunningAgentRuns.add(agentRunId);
        }
        
        callbacks.onError(errorMessage);
        callbacks.onClose();
        return;
      }
      
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        console.error('[STREAM] No auth token available');
        callbacks.onError(new Error('Authentication required'));
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
          console.log(`[STREAM] Received data for ${agentRunId}: ${rawData.substring(0, 100)}${rawData.length > 100 ? '...' : ''}`);
          
          // Skip empty messages
          if (!rawData || rawData.trim() === '') {
            console.debug('[STREAM] Received empty message, skipping');
            return;
          }
          
          // Check for "Agent run not found" error
          if (rawData.includes('Agent run') && rawData.includes('not found in active runs')) {
            console.log(`[STREAM] Agent run ${agentRunId} not found in active runs, closing stream`);
            
            // Add to non-running set to prevent future reconnection attempts
            nonRunningAgentRuns.add(agentRunId);
            
            // Notify about the error
            callbacks.onError("Agent run not found in active runs");
            
            // Clean up
            eventSource.close();
            activeStreams.delete(agentRunId);
            callbacks.onClose();
            
            return;
          }
          
          // Check for completion messages
          if (rawData.includes('"type":"status"') && rawData.includes('"status":"completed"')) {
            console.log(`[STREAM] Detected completion status message for ${agentRunId}`);
            
            // Check for specific completion messages that indicate we should stop checking
            if (rawData.includes('Run data not available for streaming') || 
                rawData.includes('Stream ended with status: completed')) {
              console.log(`[STREAM] Detected final completion message for ${agentRunId}, adding to non-running set`);
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
          if (rawData.includes('"type":"status"') && rawData.includes('"status_type":"thread_run_end"')) {
            console.log(`[STREAM] Detected thread run end message for ${agentRunId}`);
            
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
          .then(status => {
            if (status.status !== 'running') {
              console.log(`[STREAM] Agent run ${agentRunId} is not running after error, closing stream`);
              nonRunningAgentRuns.add(agentRunId);
              eventSource.close();
              activeStreams.delete(agentRunId);
              callbacks.onClose();
            } else {
              console.log(`[STREAM] Agent run ${agentRunId} is still running after error, keeping stream open`);
              // Let the browser handle reconnection for non-fatal errors
            }
          })
          .catch(err => {
            console.error(`[STREAM] Error checking agent status after stream error:`, err);
            
            // Check if this is a "not found" error
            const errMsg = err instanceof Error ? err.message : String(err);
            const isNotFoundErr = errMsg.includes('not found') || 
                                 errMsg.includes('404') || 
                                 errMsg.includes('does not exist');
            
            if (isNotFoundErr) {
              console.log(`[STREAM] Agent run ${agentRunId} not found after error, closing stream`);
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
export const createSandboxFile = async (sandboxId: string, filePath: string, content: string): Promise<void> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
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
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`Error creating sandbox file: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error creating sandbox file: ${response.statusText} (${response.status})`);
    }
    
    return response.json();
  } catch (error) {
    console.error('Failed to create sandbox file:', error);
    throw error;
  }
};

// Fallback method for legacy support using JSON
export const createSandboxFileJson = async (sandboxId: string, filePath: string, content: string): Promise<void> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files/json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: filePath,
        content: content
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`Error creating sandbox file (JSON): ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error creating sandbox file: ${response.statusText} (${response.status})`);
    }
    
    return response.json();
  } catch (error) {
    console.error('Failed to create sandbox file with JSON:', error);
    throw error;
  }
};

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
  permissions?: string;
}

export const listSandboxFiles = async (sandboxId: string, path: string): Promise<FileInfo[]> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files`);
    url.searchParams.append('path', path);

    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url.toString(), {
      headers,
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`Error listing sandbox files: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error listing sandbox files: ${response.statusText} (${response.status})`);
    }
    
    const data = await response.json();
    return data.files || [];
  } catch (error) {
    console.error('Failed to list sandbox files:', error);
    throw error;
  }
};

export const getSandboxFileContent = async (sandboxId: string, path: string): Promise<string | Blob> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files/content`);
    url.searchParams.append('path', path);

    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url.toString(), {
      headers,
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`Error getting sandbox file content: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error getting sandbox file content: ${response.statusText} (${response.status})`);
    }
    
    // Check if it's a text file or binary file based on content-type
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text') || contentType?.includes('application/json')) {
      return await response.text();
    } else {
      return await response.blob();
    }
  } catch (error) {
    console.error('Failed to get sandbox file content:', error);
    throw error;
  }
};

export const updateThread = async (threadId: string, data: Partial<Thread>): Promise<Thread> => {
  const supabase = createClient();
  
  // Format the data for update
  const updateData = { ...data };
  
  // Update the thread
  const { data: updatedThread, error } = await supabase
    .from('threads')
    .update(updateData)
    .eq('thread_id', threadId)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating thread:', error);
    throw new Error(`Error updating thread: ${error.message}`);
  }
  
  return updatedThread;
};

export const toggleThreadPublicStatus = async (threadId: string, isPublic: boolean): Promise<Thread> => {
  return updateThread(threadId, { is_public: isPublic });
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
    const publicProjectIds = [...new Set(publicThreads.map(thread => thread.project_id))].filter(Boolean);
    
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
    
    console.log('[API] Raw public projects from DB:', projects?.length, projects);
    
    // Map database fields to our Project type
    const mappedProjects: Project[] = (projects || []).map(project => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      account_id: project.account_id,
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || { id: "", pass: "", vnc_preview: "", sandbox_url: "" },
      is_public: true // Mark these as public projects
    }));
    
    console.log('[API] Mapped public projects for frontend:', mappedProjects.length);
    
    return mappedProjects;
  } catch (err) {
    console.error('Error fetching public projects:', err);
    return [];
  }
};

