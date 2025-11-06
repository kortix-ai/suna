import { createClient } from '@/lib/supabase/client';
import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';
import { BillingError, AgentRunLimitError, ProjectLimitError, NoAccessTokenAvailableError } from './errors';
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

    // Debug logging
    console.log('[unifiedAgentStart] Sending to backend:', {
      threadId: options.threadId,
      prompt: options.prompt ? options.prompt.substring(0, 100) : undefined,
      promptLength: options.prompt?.length || 0,
      model_name: options.model_name,
      agent_id: options.agent_id,
      filesCount: options.files?.length || 0,
    });
    
    // Debug: Log FormData contents
    console.log('[unifiedAgentStart] FormData entries:');
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        console.log(`  ${key}: File(${value.name}, ${value.size} bytes)`);
      } else {
        console.log(`  ${key}: ${String(value).substring(0, 100)}`);
      }
    }

    const response = await backendApi.upload<{ thread_id: string; agent_run_id: string; status: string }>(
      '/agent/start',
      formData,
      { showErrors: false, cache: 'no-store' }
    );

    if (response.error) {
      const status = response.error.status || 500;
      
      if (status === 402) {
        const detail = response.error.details?.detail || {};
        
        if (detail.error_code === 'PROJECT_LIMIT_EXCEEDED') {
          throw new ProjectLimitError(status, {
            message: detail.message || 'Project limit exceeded',
            current_count: detail.current_count || 0,
            limit: detail.limit || 0,
            tier_name: detail.tier_name || 'none',
            error_code: detail.error_code
          });
        }
        
        throw new BillingError(status, detail);
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
    throw new Error(`Agent run ${agentRunId} is not running`);
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

export const getAgentRuns = async (threadId: string): Promise<AgentRun[]> => {
  try {
    const response = await backendApi.get<{ agent_runs: AgentRun[] }>(
      `/thread/${threadId}/agent-runs`,
      { showErrors: true, cache: 'no-store' }
    );

    if (response.error) {
      throw new Error(`Error getting agent runs: ${response.error.message}`);
    }

    return response.data?.agent_runs || [];
  } catch (error) {
    console.error('Failed to get agent runs:', error);
    handleApiError(error, { operation: 'load agent runs', resource: 'conversation history' });
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

          if (!rawData || rawData.trim() === '') {
            return;
          }

          try {
            const jsonData = JSON.parse(rawData);
            if (jsonData.status === 'error') {
              console.error(`[STREAM] Error status received for ${agentRunId}:`, jsonData);
              callbacks.onError(jsonData.message || 'Unknown error occurred');
              return;
            }
          } catch (jsonError) {
            // Not JSON or invalid JSON, continue with normal processing
          }

          if (
            rawData.includes('Agent run') &&
            rawData.includes('not found in active runs')
          ) {
            nonRunningAgentRuns.add(agentRunId);
            callbacks.onError('Agent run not found in active runs');
            cleanupEventSource(agentRunId, 'agent run not found');
            callbacks.onClose();
            return;
          }

          if (
            rawData.includes('"type": "status"') &&
            rawData.includes('"status": "completed"')
          ) {
            if (rawData.includes('Agent run completed successfully')) {
              nonRunningAgentRuns.add(agentRunId);
            }
            callbacks.onMessage(rawData);
            cleanupEventSource(agentRunId, 'agent run completed');
            callbacks.onClose();
            return;
          }

          if (
            rawData.includes('"type": "status"') &&
            rawData.includes('thread_run_end')
          ) {
            callbacks.onMessage(rawData);
            return;
          }

          callbacks.onMessage(rawData);
        } catch (error) {
          console.error(`[STREAM] Error handling message:`, error);
          callbacks.onError(error instanceof Error ? error : String(error));
        }
      };

      eventSource.onerror = (event) => {
        console.error(`[STREAM] EventSource error for ${agentRunId}:`, event);
        
        getAgentStatus(agentRunId)
          .then((status) => {
            if (status.status !== 'running') {
              nonRunningAgentRuns.add(agentRunId);
              cleanupEventSource(agentRunId, 'agent not running');
              callbacks.onClose();
            }
          })
          .catch((err) => {
            console.error(
              `[STREAM] Error checking agent status after stream error:`,
              err,
            );

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
              console.warn(`[STREAM] Cleaning up stream for ${agentRunId} due to persistent error`);
              cleanupEventSource(agentRunId, 'persistent error');
              callbacks.onError(errMsg);
              callbacks.onClose();
            }
          });
      };
    };

    setupStream();

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

