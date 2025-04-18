import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Simple cache implementation
const apiCache = {
  projects: new Map(),
  threads: new Map(),
  threadMessages: new Map(),
  agentRuns: new Map(),
  
  getProject: (projectId: string) => apiCache.projects.get(projectId),
  setProject: (projectId: string, data: any) => apiCache.projects.set(projectId, data),
  
  getProjects: () => apiCache.projects.get('all'),
  setProjects: (data: any) => apiCache.projects.set('all', data),
  
  getThreads: (projectId: string) => apiCache.threads.get(projectId || 'all'),
  setThreads: (projectId: string, data: any) => apiCache.threads.set(projectId || 'all', data),
  
  getThreadMessages: (threadId: string) => apiCache.threadMessages.get(threadId),
  setThreadMessages: (threadId: string, data: any) => apiCache.threadMessages.set(threadId, data),
  
  getAgentRuns: (threadId: string) => apiCache.agentRuns.get(threadId),
  setAgentRuns: (threadId: string, data: any) => apiCache.agentRuns.set(threadId, data),
  
  // Helper to clear parts of the cache when data changes
  invalidateThreadMessages: (threadId: string) => apiCache.threadMessages.delete(threadId),
  invalidateAgentRuns: (threadId: string) => apiCache.agentRuns.delete(threadId),
};

// Add a fetch queue system to prevent multiple simultaneous requests
const fetchQueue = {
  agentRuns: new Map<string, Promise<any>>(),
  threads: new Map<string, Promise<any>>(),
  messages: new Map<string, Promise<any>>(),
  projects: new Map<string, Promise<any>>(),
  
  getQueuedAgentRuns: (threadId: string) => fetchQueue.agentRuns.get(threadId),
  setQueuedAgentRuns: (threadId: string, promise: Promise<any>) => {
    fetchQueue.agentRuns.set(threadId, promise);
    // Auto-clean the queue after the promise resolves
    promise.finally(() => {
      fetchQueue.agentRuns.delete(threadId);
    });
    return promise;
  },
  
  getQueuedThreads: (projectId: string) => fetchQueue.threads.get(projectId || 'all'),
  setQueuedThreads: (projectId: string, promise: Promise<any>) => {
    fetchQueue.threads.set(projectId || 'all', promise);
    promise.finally(() => {
      fetchQueue.threads.delete(projectId || 'all');
    });
    return promise;
  },
  
  getQueuedMessages: (threadId: string) => fetchQueue.messages.get(threadId),
  setQueuedMessages: (threadId: string, promise: Promise<any>) => {
    fetchQueue.messages.set(threadId, promise);
    promise.finally(() => {
      fetchQueue.messages.delete(threadId);
    });
    return promise;
  },
  
  getQueuedProjects: () => fetchQueue.projects.get('all'),
  setQueuedProjects: (promise: Promise<any>) => {
    fetchQueue.projects.set('all', promise);
    promise.finally(() => {
      fetchQueue.projects.delete('all');
    });
    return promise;
  }
};

export type Project = {
  id: string;
  name: string;
  description: string;
  account_id: string;
  created_at: string;
  sandbox: {
    vnc_preview?: string;
    id?: string;
    pass?: string;
  };
}

export type Thread = {
  thread_id: string;
  account_id: string | null;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
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
  // Check if we already have a pending request
  const pendingRequest = fetchQueue.getQueuedProjects();
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Check cache first
  const cached = apiCache.getProjects();
  if (cached) {
    return cached;
  }
  
  // Create and queue the promise
  const fetchPromise = (async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('projects')
        .select('*');
      
      if (error) {
        // Handle permission errors specifically
        if (error.code === '42501' && error.message.includes('has_role_on_account')) {
          console.error('Permission error: User does not have proper account access');
          return []; // Return empty array instead of throwing
        }
        throw error;
      }
      
      // Cache the result
      apiCache.setProjects(data || []);
      return data || [];
    } catch (err) {
      console.error('Error fetching projects:', err);
      // Return empty array for permission errors to avoid crashing the UI
      return [];
    }
  })();
  
  // Add to queue and return
  return fetchQueue.setQueuedProjects(fetchPromise);
};

export const getProject = async (projectId: string): Promise<Project> => {
  // Check cache first
  const cached = apiCache.getProject(projectId);
  if (cached) {
    return cached;
  }
  
  const supabase = createClient();
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('project_id', projectId)
    .single();
  
  if (error) throw error;
  
  // Cache the result
  apiCache.setProject(projectId, data);
  return data;
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

  // Invalidate cache after successful update
  apiCache.projects.delete(projectId);
  apiCache.projects.delete('all');
  
  // Dispatch a custom event to notify components about the project change
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('project-updated', { 
      detail: { 
        projectId, 
        updatedData: {
          id: updatedData.project_id || updatedData.id,
          name: updatedData.name,
          description: updatedData.description
        }
      } 
    }));
  }
  
  return updatedData;
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
  // Check if we already have a pending request
  const pendingRequest = fetchQueue.getQueuedThreads(projectId || 'all');
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Check cache first
  const cached = apiCache.getThreads(projectId || 'all');
  if (cached) {
    return cached;
  }
  
  // Create and queue the promise
  const fetchPromise = (async () => {
    const supabase = createClient();
    let query = supabase.from('threads').select('*');
    
    if (projectId) {
      query = query.eq('project_id', projectId);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    // Cache the result
    apiCache.setThreads(projectId || 'all', data || []);
    return data || [];
  })();
  
  // Add to queue and return
  return fetchQueue.setQueuedThreads(projectId || 'all', fetchPromise);
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
  
  // Invalidate the cache for this thread's messages
  apiCache.invalidateThreadMessages(threadId);
};

export const getMessages = async (threadId: string): Promise<Message[]> => {
  // Check if we already have a pending request
  const pendingRequest = fetchQueue.getQueuedMessages(threadId);
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Check cache first
  const cached = apiCache.getThreadMessages(threadId);
  if (cached) {
    return cached;
  }
  
  // Create and queue the promise
  const fetchPromise = (async () => {
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
    
    // Process the messages to the expected format
    const messages = (data || []).map(msg => {
      try {
        // Parse the content from JSONB
        const content = typeof msg.content === 'string' 
          ? JSON.parse(msg.content) 
          : msg.content;
          
        // Return in the format the app expects
        return content;
      } catch (e) {
        console.error('Error parsing message content:', e, msg);
        // Fallback for malformed messages
        return {
          role: msg.is_llm_message ? 'assistant' : 'user',
          content: 'Error: Could not parse message content'
        };
      }
    });
    
    // Cache the result
    apiCache.setThreadMessages(threadId, messages);
    
    return messages;
  })();
  
  // Add to queue and return
  return fetchQueue.setQueuedMessages(threadId, fetchPromise);
};

// Agent APIs
export const startAgent = async (threadId: string): Promise<{ agent_run_id: string }> => {
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
      credentials: 'include',
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`[API] Error starting agent: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error starting agent: ${response.statusText} (${response.status})`);
    }
    
    // Invalidate relevant caches
    apiCache.invalidateAgentRuns(threadId);
    apiCache.invalidateThreadMessages(threadId);
    
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
  });
  
  if (!response.ok) {
    throw new Error(`Error stopping agent: ${response.statusText}`);
  }
};

export const getAgentStatus = async (agentRunId: string): Promise<AgentRun> => {
  console.log(`[API] ⚠️ Requesting agent status for ${agentRunId}`);
  
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('[API] ❌ No access token available for getAgentStatus');
      throw new Error('No access token available');
    }

    const url = `${API_URL}/agent-run/${agentRunId}`;
    console.log(`[API] 🔍 Fetching from: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
      credentials: 'include',
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      console.error(`[API] ❌ Error getting agent status: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Error getting agent status: ${response.statusText} (${response.status})`);
    }
    
    const data = await response.json();
    console.log(`[API] ✅ Successfully got agent status:`, data);
    return data;
  } catch (error) {
    console.error('[API] ❌ Failed to get agent status:', error);
    throw error;
  }
};

export const getAgentRuns = async (threadId: string): Promise<AgentRun[]> => {
  // Check if we already have a pending request for this thread ID
  const pendingRequest = fetchQueue.getQueuedAgentRuns(threadId);
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Check cache first
  const cached = apiCache.getAgentRuns(threadId);
  if (cached) {
    return cached;
  }
  
  // Create and queue the promise to prevent duplicate requests
  const fetchPromise = (async () => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    const response = await fetch(`${API_URL}/thread/${threadId}/agent-runs`, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
      credentials: 'include',
    });
    
    if (!response.ok) {
      throw new Error(`Error getting agent runs: ${response.statusText}`);
    }
    
    const data = await response.json();
    const agentRuns = data.agent_runs || [];
    
    // Cache the result
    apiCache.setAgentRuns(threadId, agentRuns);
    return agentRuns;
  })();
  
  // Add to queue and return
  return fetchQueue.setQueuedAgentRuns(threadId, fetchPromise);
};

export const streamAgent = (agentRunId: string, callbacks: {
  onMessage: (content: string) => void;
  onError: (error: Error | string) => void;
  onClose: () => void;
}): () => void => {
  let eventSourceInstance: EventSource | null = null;
  let isClosing = false;
  
  console.log(`[STREAM] Setting up stream for agent run ${agentRunId}`);
  
  const setupStream = async () => {
    try {
      if (isClosing) {
        console.log(`[STREAM] Already closing, not setting up stream for ${agentRunId}`);
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
      eventSourceInstance = new EventSource(url.toString());
      
      eventSourceInstance.onopen = () => {
        console.log(`[STREAM] Connection opened for ${agentRunId}`);
      };
      
      eventSourceInstance.onmessage = (event) => {
        try {
          const rawData = event.data;
          if (rawData.includes('"type":"ping"')) return;
          
          // Log raw data for debugging
          console.log(`[STREAM] Received data: ${rawData.substring(0, 100)}${rawData.length > 100 ? '...' : ''}`);
          
          // Skip empty messages
          if (!rawData || rawData.trim() === '') {
            console.debug('[STREAM] Received empty message, skipping');
            return;
          }
          
          // Check if this is a status completion message
          if (rawData.includes('"type":"status"') && rawData.includes('"status":"completed"')) {
            console.log(`[STREAM] ⚠️ Detected completion status message: ${rawData}`);
            
            try {
              // Explicitly call onMessage before closing the stream to ensure the message is processed
              callbacks.onMessage(rawData);
              
              // Explicitly close the EventSource connection when we receive a completion message
              if (eventSourceInstance && !isClosing) {
                console.log(`[STREAM] ⚠️ Closing EventSource due to completion message for ${agentRunId}`);
                isClosing = true;
                eventSourceInstance.close();
                eventSourceInstance = null;
                
                // Explicitly call onClose here to ensure the client knows the stream is closed
                setTimeout(() => {
                  console.log(`[STREAM] 🚨 Explicitly calling onClose after completion for ${agentRunId}`);
                  callbacks.onClose();
                }, 0);
              }
              
              // Exit early to prevent duplicate message processing
              return;
            } catch (closeError) {
              console.error(`[STREAM] ❌ Error while closing stream on completion: ${closeError}`);
              // Continue with normal processing if there's an error during closure
            }
          }
          
          // Pass the raw data directly to onMessage for handling in the component
          callbacks.onMessage(rawData);
        } catch (error) {
          console.error(`[STREAM] Error handling message:`, error);
          callbacks.onError(error instanceof Error ? error : String(error));
        }
      };
      
      eventSourceInstance.onerror = (event) => {
        // Add detailed event logging
        console.log(`[STREAM] 🔍 EventSource onerror triggered for ${agentRunId}`, event);
        
        // EventSource errors are often just connection closures
        // For clean closures (manual or completed), we don't need to log an error
        if (isClosing) {
          console.log(`[STREAM] EventSource closed as expected for ${agentRunId}`);
          return;
        }
        
        // Only log as error for unexpected closures
        console.log(`[STREAM] EventSource connection closed for ${agentRunId}`);
        
        if (!isClosing) {
          console.log(`[STREAM] Handling connection close for ${agentRunId}`);
          
          // Close the connection
          if (eventSourceInstance) {
            eventSourceInstance.close();
            eventSourceInstance = null;
          }
          
          // Then notify error (once)
          isClosing = true;
          callbacks.onClose();
        }
      };
      
    } catch (error) {
      console.error(`[STREAM] Error setting up stream:`, error);
      
      if (!isClosing) {
        isClosing = true;
        callbacks.onError(error instanceof Error ? error : String(error));
        callbacks.onClose();
      }
    }
  };
  
  // Set up the stream once
  setupStream();
  
  // Return cleanup function
  return () => {
    console.log(`[STREAM] Manual cleanup called for ${agentRunId}`);
    
    if (isClosing) {
      console.log(`[STREAM] Already closing, ignoring duplicate cleanup for ${agentRunId}`);
      return;
    }
    
    isClosing = true;
    
    if (eventSourceInstance) {
      console.log(`[STREAM] Manually closing EventSource for ${agentRunId}`);
      eventSourceInstance.close();
      eventSourceInstance = null;
    }
  };
};

// Sandbox API Functions
export const createSandboxFile = async (sandboxId: string, filePath: string, content: string): Promise<void> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    // Use FormData to handle both text and binary content more reliably
    const formData = new FormData();
    formData.append('path', filePath);
    
    // Create a Blob from the content string and append as a file
    const blob = new Blob([content], { type: 'application/octet-stream' });
    formData.append('file', blob, filePath.split('/').pop() || 'file');

    const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
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
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
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
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files`);
    url.searchParams.append('path', path);

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
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
    
    if (!session?.access_token) {
      throw new Error('No access token available');
    }

    const url = new URL(`${API_URL}/sandboxes/${sandboxId}/files/content`);
    url.searchParams.append('path', path);

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
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