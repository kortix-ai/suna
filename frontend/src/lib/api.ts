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

// Track active streams by agent run ID
const activeStreams = new Map<string, {
  eventSource: EventSource;
  lastMessageTime: number;
  subscribers: Set<{
    onMessage: (content: string) => void;
    onError: (error: Error | string) => void;
    onClose: () => void;
  }>;
}>();

// Track recent agent status requests to prevent duplicates
const recentAgentStatusRequests = new Map<string, {
  timestamp: number;
  promise: Promise<AgentRun>;
}>();

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
    
    // Cache the result
    apiCache.setThreadMessages(threadId, data || []);
    
    return data || [];
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
  
  // Check if we have a recent request for this agent run
  const now = Date.now();
  const recentRequest = recentAgentStatusRequests.get(agentRunId);
  
  // If we have a request from the last 2 seconds, reuse its promise
  if (recentRequest && now - recentRequest.timestamp < 2000) {
    console.log(`[API] 🔄 Reusing recent status request for ${agentRunId} from ${now - recentRequest.timestamp}ms ago`);
    return recentRequest.promise;
  }
  
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error('[API] ❌ No access token available for getAgentStatus');
      throw new Error('No access token available');
    }

    const url = `${API_URL}/agent-run/${agentRunId}`;
    console.log(`[API] 🔍 Fetching from: ${url}`);
    
    // Create the promise for this request
    const requestPromise = (async () => {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error details available');
        console.error(`[API] ❌ Error getting agent status: ${response.status} ${response.statusText}`, errorText);
        throw new Error(`Error getting agent status: ${response.statusText} (${response.status})`);
      }
      
      const data = await response.json();
      console.log(`[API] ✅ Successfully got agent status:`, data);
      
      // Clean up old entries after 5 seconds
      setTimeout(() => {
        const entry = recentAgentStatusRequests.get(agentRunId);
        if (entry && entry.timestamp === now) {
          recentAgentStatusRequests.delete(agentRunId);
        }
      }, 5000);
      
      return data;
    })();
    
    // Store this request in our cache
    recentAgentStatusRequests.set(agentRunId, {
      timestamp: now,
      promise: requestPromise
    });
    
    return requestPromise;
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
  console.log(`[STREAM] streamAgent called for ${agentRunId}, active streams: ${Array.from(activeStreams.keys()).join(', ')}`);
  
  // Check if there's already an active stream for this agent run
  let activeStream = activeStreams.get(agentRunId);
  
  // If we already have a stream, just add this subscriber
  if (activeStream) {
    console.log(`[STREAM] Reusing existing stream for ${agentRunId}, adding subscriber`);
    activeStream.subscribers.add(callbacks);
    
    // Return a cleanup function for this specific subscriber
    return () => {
      console.log(`[STREAM] Removing subscriber from ${agentRunId}`);
      const stream = activeStreams.get(agentRunId);
      if (stream) {
        stream.subscribers.delete(callbacks);
        
        // If no subscribers remain, clean up the stream
        if (stream.subscribers.size === 0) {
          console.log(`[STREAM] No subscribers left for ${agentRunId}, closing stream`);
          stream.eventSource.close();
          activeStreams.delete(agentRunId);
        }
      }
    };
  }
  
  // If no active stream exists, create a new one
  console.log(`[STREAM] Creating new stream for ${agentRunId}`);
  let isClosing = false;
  
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
      const eventSource = new EventSource(url.toString());
      
      // Create and add to active streams map immediately
      activeStream = {
        eventSource,
        lastMessageTime: Date.now(),
        subscribers: new Set([callbacks])
      };
      
      activeStreams.set(agentRunId, activeStream);
      
      eventSource.onopen = () => {
        console.log(`[STREAM] Connection opened for ${agentRunId}`);
      };
      
      eventSource.onmessage = (event) => {
        try {
          const rawData = event.data;
          if (rawData.includes('"type":"ping"')) return;
          
          // Update last message time
          if (activeStream) {
            activeStream.lastMessageTime = Date.now();
          }
          
          // Log raw data for debugging (truncated for readability)
          console.log(`[STREAM] Received data for ${agentRunId}: ${rawData.substring(0, 100)}${rawData.length > 100 ? '...' : ''}`);
          
          // Skip empty messages
          if (!rawData || rawData.trim() === '') {
            console.debug('[STREAM] Received empty message, skipping');
            return;
          }
          
          // Check for "Agent run not found" error
          if (rawData.includes('Agent run') && rawData.includes('not found in active runs')) {
            console.log(`[STREAM] ⚠️ Agent run ${agentRunId} not found in active runs, closing stream`);
            
            // Notify subscribers about the error
            const currentStream = activeStreams.get(agentRunId);
            if (currentStream) {
              currentStream.subscribers.forEach(subscriber => {
                try {
                  subscriber.onError("Agent run not found in active runs");
                  subscriber.onClose();
                } catch (subError) {
                  console.error(`[STREAM] Error in subscriber notification for not found:`, subError);
                }
              });
            }
            
            // Clean up stream since agent is not found
            if (!isClosing) {
              cleanupStream();
            }
            return;
          }
          
          // Check for simple completion status message
          if (rawData.includes('"type":"status"') && rawData.includes('"status":"completed"')) {
            console.log(`[STREAM] ⚠️ Detected simple completion status message for ${agentRunId}, closing stream`);
            
            // Notify all subscribers this is the final message
            const currentStream = activeStreams.get(agentRunId);
            if (currentStream) {
              currentStream.subscribers.forEach(subscriber => {
                try {
                  subscriber.onMessage(rawData);
                } catch (subError) {
                  console.error(`[STREAM] Error in subscriber onMessage for completion:`, subError);
                }
              });
            }
            
            // Clean up stream since agent is complete
            if (!isClosing) {
              cleanupStream();
            }
            return;
          }
          
          // Check for completion status message
          const isCompletionMessage = rawData.includes('"type":"status"') && 
            (rawData.includes('"status":"completed"') || 
             rawData.includes('"status_type":"thread_run_end"'));
          
          if (isCompletionMessage) {
            console.log(`[STREAM] ⚠️ Detected completion status message for ${agentRunId}`);
          }
          
          // Notify all subscribers about this message
          const currentStream = activeStreams.get(agentRunId);
          if (currentStream) {
            currentStream.subscribers.forEach(subscriber => {
              try {
                subscriber.onMessage(rawData);
              } catch (subError) {
                console.error(`[STREAM] Error in subscriber onMessage:`, subError);
                // Don't let subscriber errors affect other subscribers
              }
            });
          }
          
          // Handle completion message cleanup after delivering to subscribers
          if (isCompletionMessage && !isClosing) {
            console.log(`[STREAM] ⚠️ Closing stream due to completion message for ${agentRunId}`);
            cleanupStream();
          }
        } catch (error) {
          console.error(`[STREAM] Error handling message:`, error);
          // Notify error without closing the stream to allow retries
          const currentStream = activeStreams.get(agentRunId);
          if (currentStream) {
            currentStream.subscribers.forEach(subscriber => {
              try {
                subscriber.onError(error instanceof Error ? error : String(error));
              } catch (subError) {
                console.error(`[STREAM] Error in subscriber onError:`, subError);
              }
            });
          }
        }
      };
      
      eventSource.onerror = (event) => {
        console.log(`[STREAM] 🔍 EventSource error for ${agentRunId}:`, event);
        
        if (isClosing) {
          console.log(`[STREAM] Error ignored because stream is closing for ${agentRunId}`);
          return;
        }
        
        // Check if we need to verify agent run status
        const shouldVerifyAgentStatus = (event as any).target?.readyState === 2; // CLOSED
        
        if (shouldVerifyAgentStatus) {
          console.log(`[STREAM] Connection closed, verifying if agent run ${agentRunId} still exists`);
          
          // Verify if the agent run still exists before reconnecting
          getAgentStatus(agentRunId)
            .then(status => {
              if (status.status === 'running') {
                console.log(`[STREAM] Agent run ${agentRunId} is still running, will attempt reconnection`);
                // Don't clean up, let the page component handle reconnection
              } else {
                console.log(`[STREAM] Agent run ${agentRunId} is no longer running (${status.status}), cleaning up stream`);
                cleanupStream();
              }
            })
            .catch(err => {
              console.error(`[STREAM] Error checking agent status after connection error:`, err);
              
              // If we get a 404 or similar error, the agent run doesn't exist
              if (err.message && (
                  err.message.includes('not found') || 
                  err.message.includes('404') || 
                  err.message.includes('does not exist')
                )) {
                console.log(`[STREAM] Agent run ${agentRunId} appears to not exist, cleaning up stream`);
                cleanupStream();
              } else {
                // For other errors, we'll let the page component handle reconnection
                console.log(`[STREAM] Network or other error checking agent status, will let page handle reconnection`);
              }
            });
        } else {
          // For other types of errors, we'll attempt to keep the stream alive
          console.log(`[STREAM] Non-fatal error for ${agentRunId}, keeping stream alive`);
        }
      };
      
    } catch (error) {
      console.error(`[STREAM] Error setting up stream for ${agentRunId}:`, error);
      
      if (!isClosing) {
        callbacks.onError(error instanceof Error ? error : String(error));
        cleanupStream();
      }
    }
  };
  
  const cleanupStream = () => {
    if (isClosing) return;
    isClosing = true;
    
    console.log(`[STREAM] Cleaning up stream for ${agentRunId}`);
    
    const stream = activeStreams.get(agentRunId);
    if (stream) {
      // Close the EventSource
      stream.eventSource.close();
      
      // Notify all subscribers
      stream.subscribers.forEach(subscriber => {
        try {
          subscriber.onClose();
        } catch (error) {
          console.error(`[STREAM] Error in subscriber onClose:`, error);
        }
      });
      
      // Remove from active streams
      activeStreams.delete(agentRunId);
    }
  };
  
  // Setup the stream
  setupStream();
  
  // Return cleanup function for this subscriber
  return () => {
    console.log(`[STREAM] Cleanup called for ${agentRunId}`);
    
    const stream = activeStreams.get(agentRunId);
    if (stream) {
      // Remove this subscriber
      stream.subscribers.delete(callbacks);
      
      // If this was the last subscriber, clean up the entire stream
      if (stream.subscribers.size === 0) {
        console.log(`[STREAM] Last subscriber removed, closing stream for ${agentRunId}`);
        if (!isClosing) {
          cleanupStream();
        }
      } else {
        console.log(`[STREAM] Subscriber removed, but ${stream.subscribers.size} still active for ${agentRunId}`);
      }
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

    // Determine if content is likely binary (contains non-printable characters)
    const isProbablyBinary = /[\x00-\x08\x0E-\x1F\x80-\xFF]/.test(content) ||
                            content.startsWith('data:') || 
                            /^[A-Za-z0-9+/]*={0,2}$/.test(content);
    
    const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        path: filePath,
        content: content,
        is_base64: isProbablyBinary
      }),
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
