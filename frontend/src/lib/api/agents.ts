import { createClient } from '@/lib/supabase/client';
import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';
import { BillingError, AgentRunLimitError, ProjectLimitError, ThreadLimitError, NoAccessTokenAvailableError, RequestTooLargeError, parseTierRestrictionError } from './errors';
import { nonRunningAgentRuns, activeStreams, cleanupEventSource } from './streaming';
import { Message } from './threads';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

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

export interface UnifiedAgentStartResponse {
  thread_id: string;
  agent_run_id: string;
  status: string;
  project_id?: string;
}

export interface OptimisticAgentStartResponse {
  thread_id: string;
  project_id: string;
  agent_run_id: null;
  status: 'pending';
}

export interface AgentIconGenerationRequest {
  name: string;
  description?: string;
}

export interface AgentIconGenerationResponse {
  icon_name: string;
  icon_color: string;
  icon_background: string;
}

export interface AgentSetupFromChatRequest {
  description: string;
}

export interface AgentSetupFromChatResponse {
  agent_id: string;
  name: string;
  system_prompt: string;
  icon_name: string;
  icon_color: string;
  icon_background: string;
}

export interface ActiveAgentRun {
  id: string;
  thread_id: string;
  status: 'running';
  started_at: string;
}

export const unifiedAgentStart = async (options: {
  threadId?: string;
  prompt?: string;
  files?: File[];
  file_ids?: string[];
  model_name?: string;
  agent_id?: string;
}): Promise<{ thread_id: string; agent_run_id: string; status: string }> => {
  try {
    if (!API_URL) {
      throw new Error(
        'Backend URL is not configured. Set NEXT_PUBLIC_BACKEND_URL in your environment.',
      );
    }

    const formData = new FormData();
    
    if (options.threadId) {
      formData.append('thread_id', options.threadId);
    }
    
    // For new threads (no threadId), prompt is required
    // Always append prompt if provided (even if empty string) so backend can validate
    if (options.prompt !== undefined) {
      const promptValue = typeof options.prompt === 'string' ? options.prompt.trim() : options.prompt;
      formData.append('prompt', promptValue);
    }
    
    if (options.model_name && options.model_name.trim()) {
      formData.append('model_name', options.model_name.trim());
    }
    
    if (options.agent_id) {
      formData.append('agent_id', options.agent_id);
    }
    
    if (options.files && options.files.length > 0) {
      options.files.forEach((file) => {
        formData.append('files', file);
      });
    }
    
    if (options.file_ids && options.file_ids.length > 0) {
      options.file_ids.forEach((fileId) => {
        formData.append('file_ids', fileId);
      });
    }


    const response = await backendApi.upload<{ thread_id: string; agent_run_id: string; status: string }>(
      '/agent/start',
      formData,
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      const status = response.error.status || 500;
      
      // Check if error is already parsed by api-client (e.g., AgentRunLimitError)
      if (response.error instanceof AgentRunLimitError) {
        throw response.error;
      }
      
      if (status === 402) {
        // Check error_code to determine the correct error type
        const errorDetail = response.error.details?.detail || { message: response.error.message || 'Payment required' };
        const errorCode = errorDetail.error_code || response.error.code;
        
        // Handle concurrent agent run limit (should be AgentRunLimitError, not BillingError)
        if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED') {
          const detail = {
            message: errorDetail.message || `Maximum of ${errorDetail.limit || 1} concurrent agent runs allowed. You currently have ${errorDetail.running_count || 0} running.`,
            running_thread_ids: errorDetail.running_thread_ids || [],
            running_count: errorDetail.running_count || 0,
            limit: errorDetail.limit || 1,
          };
          throw new AgentRunLimitError(status, detail);
        }
        
        // For other 402 errors, use parseTierRestrictionError to get the correct error type
        const parsedError = parseTierRestrictionError({
          status,
          detail: errorDetail,
          response: { data: { detail: errorDetail } },
        });
        
        // If parseTierRestrictionError returned a different error type, throw that
        if (!(parsedError instanceof BillingError) && parsedError instanceof Error) {
          throw parsedError;
        }
        
        // Otherwise, throw BillingError
        throw new BillingError(status, errorDetail);
      }

      if (status === 429) {
        const detail = response.error.details?.detail || { 
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
        throw new AgentRunLimitError(status, detail);
      }

      // Handle HTTP 431 - Request Header Fields Too Large
      // This happens when uploading many files at once
      if (status === 431 || response.error instanceof RequestTooLargeError) {
        const filesCount = options.files?.length || 0;
        throw new RequestTooLargeError(431, {
          message: `Request is too large (${filesCount} files attached)`,
          suggestion: filesCount > 1 
            ? 'Try uploading files one at a time instead of all at once.'
            : 'The file or request data is too large. Try a smaller file or simplify your message.',
        });
      }

      console.error(
        `[API] Error starting agent: ${status} ${response.error.message}`,
      );
    
      if (status === 401) {
        throw new Error('Authentication error: Please sign in again');
      } else if (status >= 500) {
        throw new Error('Server error: Please try again later');
      }
    
      throw new Error(
        `Error starting agent: ${response.error.message} (${status})`,
      );
    }

    return response.data!;
  } catch (error) {
    if (error instanceof BillingError || error instanceof AgentRunLimitError || error instanceof ProjectLimitError) {
      throw error;
    }

    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    if (error instanceof RequestTooLargeError) {
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

  const response = await backendApi.post(
    `/agent-run/${agentRunId}/stop`,
    {},
    { showErrors: true, cache: 'no-store' }
  );

  if (typeof window !== 'undefined' && (window as any).posthog) {
    (window as any).posthog.capture('task_abandoned', { agentRunId });
  }

  if (response.error) {
    const stopError = new Error(`Error stopping agent: ${response.error.message}`);
    handleApiError(stopError, { operation: 'stop agent', resource: 'AI assistant' });
    throw stopError;
  }
};

export const getAgentStatus = async (agentRunId: string): Promise<AgentRun> => {
  if (nonRunningAgentRuns.has(agentRunId)) {
    throw new Error(`Worker run ${agentRunId} is not running`);
  }

  try {
    const response = await backendApi.get<AgentRun>(
      `/agent-run/${agentRunId}`,
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      if (response.error.status === 404) {
        nonRunningAgentRuns.add(agentRunId);
      }
      console.error(
        `[API] Error getting agent status: ${response.error.status} ${response.error.message}`,
      );
      throw new Error(
        `Error getting agent status: ${response.error.message} (${response.error.status})`,
      );
    }

    const data = response.data!;
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

export const generateAgentIcon = async (request: AgentIconGenerationRequest): Promise<AgentIconGenerationResponse> => {
  try {
    const response = await backendApi.post<AgentIconGenerationResponse>(
      '/agents/generate-icon',
      request,
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error generating agent icon: ${response.error.message} (${response.error.status})`,
      );
    }

    return response.data!;
  } catch (error) {
    console.error('[API] Failed to generate agent icon:', error);
    handleApiError(error, { operation: 'generate agent icon', resource: 'agent icon generation' });
    throw error;
  }
};

export const setupAgentFromChat = async (request: AgentSetupFromChatRequest): Promise<AgentSetupFromChatResponse> => {
  try {
    const response = await backendApi.post<AgentSetupFromChatResponse>(
      '/agents/setup-from-chat',
      request,
      { showErrors: true, timeout: 20000 } // 20 seconds (single optimized LLM call)
    );

    if (response.error) {
      throw new Error(
        `Error setting up agent from chat: ${response.error.message} (${response.error.status})`,
      );
    }

    return response.data!;
  } catch (error) {
    console.error('[API] Failed to setup agent from chat:', error);
    handleApiError(error, { operation: 'setup agent from chat', resource: 'agent setup' });
    throw error;
  }
};

export const getAgentRuns = async (threadId: string): Promise<AgentRun[]> => {
  try {
    const response = await backendApi.get<{ agent_runs: AgentRun[] }>(
      `/thread/${threadId}/agent-runs`,
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      const error = new Error(`Error getting agent runs: HTTP ${response.error.status}: ${response.error.message}`);
      (error as any).status = response.error.status;
      throw error;
    }

    return response.data?.agent_runs || [];
  } catch (error) {
    throw error;
  }
};

export const getActiveAgentRuns = async (): Promise<ActiveAgentRun[]> => {
  try {
    const response = await backendApi.get<{ active_runs: ActiveAgentRun[] }>(
      '/agent-runs/active',
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      console.warn(`Failed to fetch active agent runs: ${response.error.status} ${response.error.message}`);
      return [];
    }

    return response.data?.active_runs || [];
  } catch (error) {
    console.warn('Error fetching active agent runs:', error);
    return [];
  }
};

export const optimisticAgentStart = async (options: {
  thread_id: string;
  project_id: string;
  prompt: string;
  files?: File[];
  file_ids?: string[];
  model_name?: string;
  agent_id?: string;
  memory_enabled?: boolean;
}): Promise<OptimisticAgentStartResponse> => {
  try {
    if (!API_URL) {
      throw new Error(
        'Backend URL is not configured. Set NEXT_PUBLIC_BACKEND_URL in your environment.',
      );
    }

    const formData = new FormData();
    
    formData.append('thread_id', options.thread_id);
    formData.append('project_id', options.project_id);
    formData.append('optimistic', 'true');
    
    const promptValue = typeof options.prompt === 'string' ? options.prompt.trim() : options.prompt;
    formData.append('prompt', promptValue);
    
    if (options.model_name && options.model_name.trim()) {
      formData.append('model_name', options.model_name.trim());
    }
    
    if (options.agent_id) {
      formData.append('agent_id', options.agent_id);
    }
    
    if (options.file_ids && options.file_ids.length > 0) {
      options.file_ids.forEach((fileId) => {
        formData.append('file_ids', fileId);
      });
    } else if (options.files && options.files.length > 0) {
      options.files.forEach((file) => {
        formData.append('files', file);
      });
    }
    
    if (options.memory_enabled !== undefined) {
      formData.append('memory_enabled', String(options.memory_enabled));
    }

    const response = await backendApi.upload<OptimisticAgentStartResponse>(
      '/agent/start',  // Now using unified endpoint
      formData,
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      const status = response.error.status || 500;
      
      // Check if error is already parsed by api-client (e.g., AgentRunLimitError)
      if (response.error instanceof AgentRunLimitError) {
        throw response.error;
      }
      
      if (status === 402) {
        const errorDetail = response.error.details?.detail || { message: response.error.message || 'Payment required' };
        const parsedError = parseTierRestrictionError({
          status,
          detail: errorDetail,
          response: { data: { detail: errorDetail } },
        });
        throw parsedError;
      }

      if (status === 429) {
        const detail = response.error.details?.detail || { 
          message: 'Too many agent runs running',
          running_thread_ids: [],
          running_count: 0,
        };
        throw new AgentRunLimitError(status, detail);
      }

      if (status === 431 || response.error instanceof RequestTooLargeError) {
        const filesCount = options.files?.length || 0;
        throw new RequestTooLargeError(431, {
          message: `Request is too large (${filesCount} files attached)`,
          suggestion: filesCount > 1 
            ? 'Try uploading files one at a time instead of all at once.'
            : 'The file or request data is too large. Try a smaller file or simplify your message.',
        });
      }

      console.error(
        `[API] Error starting agent optimistically: ${status} ${response.error.message}`,
      );
    
      if (status === 401) {
        throw new Error('Authentication error: Please sign in again');
      } else if (status >= 500) {
        throw new Error('Server error: Please try again later');
      }
    
      throw new Error(
        `Error starting agent: ${response.error.message} (${status})`,
      );
    }

    return response.data!;
  } catch (error) {
    if (error instanceof BillingError || error instanceof AgentRunLimitError || error instanceof ProjectLimitError || error instanceof ThreadLimitError) {
      throw error;
    }

    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }

    if (error instanceof RequestTooLargeError) {
      throw error;
    }

    console.error('[API] Failed to start agent optimistically:', error);
    
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

export const startAgentOnThread = async (
  threadId: string,
  options?: {
    model_name?: string;
    agent_id?: string;
  }
): Promise<{ thread_id: string; agent_run_id: string; status: string }> => {
  try {
    const response = await backendApi.post<{ thread_id: string; agent_run_id: string; status: string }>(
      `/thread/${threadId}/start-agent`,
      {
        model_name: options?.model_name,
        agent_id: options?.agent_id,
      },
      { showErrors: true, cache: 'no-store' }
    );

    if (response.error) {
      throw new Error(`Error starting agent on thread: ${response.error.message}`);
    }

    return response.data!;
  } catch (error) {
    console.error('[API] Failed to start agent on thread:', error);
    handleApiError(error, { operation: 'start agent on thread', resource: 'AI assistant' });
    throw error;
  }
};

/**
 * Connect to agent run stream with retry logic and proper connection handling.
 * 
 * The backend now:
 * 1. Pre-creates the Redis stream when agent_run is created
 * 2. Sends 'connected' message immediately upon stream connection
 * 3. Streams all agent responses via SSE
 * 
 * This function handles:
 * - Connection retries with exponential backoff
 * - Proper connection state tracking
 * - Error recovery
 * - Status verification
 */
export const streamAgent = (
  agentRunId: string,
  callbacks: {
    onMessage: (content: string) => void;
    onError: (error: Error | string) => void;
    onClose: () => void;
  },
): (() => void) => {
  // Only skip if we KNOW this run has definitively ended
  if (nonRunningAgentRuns.has(agentRunId)) {
    setTimeout(() => {
      callbacks.onClose();
    }, 0);
    return () => {};
  }

  const existingStream = activeStreams.get(agentRunId);
  if (existingStream) {
    cleanupEventSource(agentRunId, 'replacing existing stream');
  }

  let retryCount = 0;
  const MAX_RETRIES = 3;
  const INITIAL_RETRY_DELAY = 1000; // 1 second
  let connectionTimeoutId: NodeJS.Timeout | null = null;
  let retryTimeoutId: NodeJS.Timeout | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    isCleanedUp = true;
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
    if (retryTimeoutId) {
      clearTimeout(retryTimeoutId);
      retryTimeoutId = null;
    }
    cleanupEventSource(agentRunId, 'cleanup');
  };

  const setupStream = async (attempt: number = 0): Promise<void> => {
    if (isCleanedUp) return;

    console.log(`[AGENT_FLOW] FRONTEND: Setting up stream (agent_run_id: ${agentRunId}, attempt: ${attempt + 1}/${MAX_RETRIES + 1})`);

    try {
      console.log(`[AGENT_FLOW] FRONTEND STEP 1: Getting auth session`);
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        console.error(`[AGENT_FLOW] FRONTEND: No access token available`);
        callbacks.onError(new NoAccessTokenAvailableError());
        callbacks.onClose();
        cleanup();
        return;
      }
      console.log(`[AGENT_FLOW] FRONTEND STEP 1: Auth session obtained`);

      const url = new URL(`${API_URL}/agent-run/${agentRunId}/stream`);
      url.searchParams.append('token', session.access_token);
      console.log(`[AGENT_FLOW] FRONTEND STEP 2: Creating EventSource (url: ${url.toString().replace(session.access_token, 'TOKEN')})`);

      const eventSource = new EventSource(url.toString());
      
      if (isCleanedUp) {
        eventSource.close();
        return;
      }

      activeStreams.set(agentRunId, eventSource);
      console.log(`[AGENT_FLOW] FRONTEND STEP 2: EventSource created and registered`);

      let hasReceivedConnected = false;
      let hasReceivedData = false;
      let connectionEstablished = false;

      // Connection timeout: if we don't get 'connected' within 10 seconds, retry
      connectionTimeoutId = setTimeout(() => {
        if (!hasReceivedConnected && !isCleanedUp) {
          console.warn(`[AGENT_FLOW] FRONTEND: Connection timeout (no 'connected' message after 10s, agent_run_id: ${agentRunId})`);
          eventSource.close();
          activeStreams.delete(agentRunId);
          
          if (attempt < MAX_RETRIES) {
            const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
            console.log(`[AGENT_FLOW] FRONTEND: Retrying connection in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            retryTimeoutId = setTimeout(() => {
              setupStream(attempt + 1);
            }, delay);
          } else {
            console.error(`[AGENT_FLOW] FRONTEND: Max retries reached (agent_run_id: ${agentRunId})`);
            callbacks.onError('Failed to connect to agent stream after multiple attempts');
            callbacks.onClose();
            cleanup();
          }
        }
      }, 10000);

      eventSource.onopen = () => {
        connectionEstablished = true;
        console.log(`[AGENT_FLOW] FRONTEND STEP 3: EventSource opened (agent_run_id: ${agentRunId})`);
      };

      eventSource.onmessage = (event) => {
        try {
          const rawData = event.data;
          if (!rawData || rawData.trim() === '') return;

          // Handle 'connected' message - confirms stream is ready
          if (rawData.includes('"type": "connected"')) {
            hasReceivedConnected = true;
            hasReceivedData = true;
            if (connectionTimeoutId) {
              clearTimeout(connectionTimeoutId);
              connectionTimeoutId = null;
            }
            console.log(`[AGENT_FLOW] FRONTEND STEP 4: Received 'connected' message (agent_run_id: ${agentRunId})`);
            return;
          }

          // Skip pings but note we're connected
          if (rawData.includes('"type": "ping"')) {
            hasReceivedData = true;
            return;
          }

          hasReceivedData = true;

          // Parse to check for terminal states
          try {
            const jsonData = JSON.parse(rawData);
            
            // Handle error status
            if (jsonData.type === 'status' && jsonData.status === 'error') {
              console.error(`[AGENT_FLOW] FRONTEND: Error status received (agent_run_id: ${agentRunId}):`, jsonData);
              callbacks.onError(jsonData.message || 'Unknown error');
              nonRunningAgentRuns.add(agentRunId);
              cleanup();
              callbacks.onClose();
              return;
            }

            // Handle completion states - mark as done and close
            if (jsonData.type === 'status' && ['completed', 'failed', 'stopped'].includes(jsonData.status)) {
              console.log(`[AGENT_FLOW] FRONTEND: Terminal status received (agent_run_id: ${agentRunId}, status: ${jsonData.status})`);
              nonRunningAgentRuns.add(agentRunId);
              callbacks.onMessage(rawData);
              cleanup();
              callbacks.onClose();
              return;
            }
          } catch {
            // Not valid JSON, continue
          }

          // Forward all other messages
          callbacks.onMessage(rawData);
        } catch (error) {
          console.error(`[STREAM] Error handling message:`, error);
        }
      };

      eventSource.onerror = () => {
        if (isCleanedUp) return;

        // Clear connection timeout since we're handling the error
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }

        // If we got 'connected' but then error, check status
        if (hasReceivedConnected) {
          console.warn(`[AGENT_FLOW] FRONTEND: Stream error after connection (agent_run_id: ${agentRunId}), checking status`);
          getAgentStatus(agentRunId)
            .then((status) => {
              console.log(`[AGENT_FLOW] FRONTEND: Status check result (agent_run_id: ${agentRunId}, status: ${status.status})`);
              if (['completed', 'failed', 'stopped'].includes(status.status)) {
                nonRunningAgentRuns.add(agentRunId);
                callbacks.onMessage(JSON.stringify({ type: 'status', status: status.status }));
              }
              cleanup();
              callbacks.onClose();
            })
            .catch(() => {
              console.error(`[AGENT_FLOW] FRONTEND: Status check failed (agent_run_id: ${agentRunId})`);
              cleanup();
              callbacks.onClose();
            });
          return;
        }

        // Never got 'connected' - might be connection issue
        console.warn(`[AGENT_FLOW] FRONTEND: Connection error (no 'connected' message, agent_run_id: ${agentRunId})`);
        eventSource.close();
        activeStreams.delete(agentRunId);

        // Retry if we haven't exceeded max retries
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          console.log(`[STREAM] Retrying connection for ${agentRunId} in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          retryTimeoutId = setTimeout(() => {
            setupStream(attempt + 1);
          }, delay);
        } else {
          // Check status one more time before giving up
          getAgentStatus(agentRunId)
            .then((status) => {
              if (['completed', 'failed', 'stopped'].includes(status.status)) {
                nonRunningAgentRuns.add(agentRunId);
                callbacks.onMessage(JSON.stringify({ type: 'status', status: status.status }));
              } else {
                callbacks.onError('Failed to connect to agent stream after multiple attempts');
              }
              cleanup();
              callbacks.onClose();
            })
            .catch(() => {
              callbacks.onError('Failed to connect to agent stream and could not verify status');
              cleanup();
              callbacks.onClose();
            });
        }
      };
    } catch (error) {
      console.error(`[STREAM] Setup error for ${agentRunId}:`, error);
      
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
        retryTimeoutId = setTimeout(() => {
          setupStream(attempt + 1);
        }, delay);
      } else {
        callbacks.onError(error instanceof Error ? error : String(error));
        callbacks.onClose();
        cleanup();
      }
    }
  };

  setupStream();

  return () => {
    cleanup();
  };
};

