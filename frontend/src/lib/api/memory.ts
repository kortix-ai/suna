import { backendApi } from '../api-client';
import { handleApiError } from '../error-handler';

export interface Memory {
  memory_id: string;
  content: string;
  memory_type: 'fact' | 'preference' | 'context' | 'conversation_summary';
  confidence_score: number;
  source_thread_id?: string;
  metadata: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface MemoryStats {
  total_memories: number;
  memories_by_type: Record<string, number>;
  oldest_memory?: string;
  newest_memory?: string;
  max_memories: number;
  retrieval_limit: number;
  tier_name: string;
  memory_enabled: boolean;
}

export interface MemorySettings {
  memory_enabled: boolean;
}

export interface ThreadMemorySettings {
  thread_id: string;
  memory_enabled: boolean;
}

export interface MemoryListResponse {
  memories: Memory[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface CreateMemoryRequest {
  content: string;
  memory_type?: 'fact' | 'preference' | 'context' | 'conversation_summary';
  confidence_score?: number;
  metadata?: Record<string, any>;
}

export const listMemories = async (params?: {
  page?: number;
  limit?: number;
  memory_type?: string;
}): Promise<MemoryListResponse> => {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.append('page', params.page.toString());
  if (params?.limit) searchParams.append('limit', params.limit.toString());
  if (params?.memory_type) searchParams.append('memory_type', params.memory_type);
  
  const queryString = searchParams.toString();
  const url = queryString ? `/memory/memories?${queryString}` : '/memory/memories';
  
  const response = await backendApi.get<MemoryListResponse>(url, {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'list memories' });
    throw new Error(response.error.message || 'Failed to list memories');
  }

  return response.data!;
};

export const getMemoryStats = async (): Promise<MemoryStats> => {
  const response = await backendApi.get<MemoryStats>('/memory/stats', {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'get memory stats' });
    throw new Error(response.error.message || 'Failed to get memory stats');
  }

  return response.data!;
};

export const deleteMemory = async (memoryId: string): Promise<{ message: string; memory_id: string }> => {
  const response = await backendApi.delete<{ message: string; memory_id: string }>(
    `/memory/memories/${memoryId}`,
    { showErrors: true }
  );

  if (response.error) {
    handleApiError(response.error, { operation: 'delete memory', resource: `memory ${memoryId}` });
    throw new Error(response.error.message || 'Failed to delete memory');
  }

  return response.data!;
};

export const deleteAllMemories = async (confirm: boolean = true): Promise<{ message: string; deleted_count: number }> => {
  const response = await backendApi.delete<{ message: string; deleted_count: number }>(
    `/memory/memories?confirm=${confirm}`,
    {
      showErrors: true,
    }
  );

  if (response.error) {
    handleApiError(response.error, { operation: 'delete all memories' });
    throw new Error(response.error.message || 'Failed to delete all memories');
  }

  return response.data!;
};

export const createMemory = async (data: CreateMemoryRequest): Promise<Memory> => {
  const response = await backendApi.post<Memory>('/memory/memories', data, {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'create memory' });
    throw new Error(response.error.message || 'Failed to create memory');
  }

  return response.data!;
};

export const getMemorySettings = async (): Promise<MemorySettings> => {
  const response = await backendApi.get<MemorySettings>('/memory/settings', {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'get memory settings' });
    throw new Error(response.error.message || 'Failed to get memory settings');
  }

  return response.data!;
};

export const updateMemorySettings = async (enabled: boolean): Promise<MemorySettings> => {
  const response = await backendApi.put<MemorySettings>('/memory/settings', { enabled }, {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'update memory settings' });
    throw new Error(response.error.message || 'Failed to update memory settings');
  }

  return response.data!;
};

export const getThreadMemorySettings = async (threadId: string): Promise<ThreadMemorySettings> => {
  const response = await backendApi.get<ThreadMemorySettings>(`/memory/thread/${threadId}/settings`, {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'get thread memory settings' });
    throw new Error(response.error.message || 'Failed to get thread memory settings');
  }

  return response.data!;
};

export const updateThreadMemorySettings = async (threadId: string, enabled: boolean): Promise<ThreadMemorySettings> => {
  const response = await backendApi.put<ThreadMemorySettings>(`/memory/thread/${threadId}/settings`, { enabled }, {
    showErrors: true,
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'update thread memory settings' });
    throw new Error(response.error.message || 'Failed to update thread memory settings');
  }

  return response.data!;
};
