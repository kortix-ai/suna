import { createClient } from '@/lib/supabase/client';
import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';

export type Thread = {
  thread_id: string;
  project_id?: string | null;
  is_public?: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: any;
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

export interface ThreadsResponse {
  threads: Thread[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export const getThreads = async (projectId?: string): Promise<Thread[]> => {
  try {
    const response = await backendApi.get<{ threads: any[] }>('/threads', {
      showErrors: false,
    });

    if (response.error) {
      console.error('Error getting threads:', response.error);
      handleApiError(response.error, { 
        operation: 'load threads', 
        resource: projectId ? `threads for project ${projectId}` : 'threads' 
      });
      return [];
    }

    if (!response.data?.threads) {
      return [];
    }

    let threads = response.data.threads.map((thread: any) => ({
      thread_id: thread.thread_id,
      project_id: thread.project_id,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      metadata: thread.metadata || {},
    }));

    if (projectId) {
      threads = threads.filter((thread: Thread) => thread.project_id === projectId);
    }

    return threads;
  } catch (err) {
    console.error('Error fetching threads:', err);
    handleApiError(err, { 
      operation: 'load threads', 
      resource: projectId ? `threads for project ${projectId}` : 'threads' 
    });
    return [];
  }
};

export const getThreadsPaginated = async (projectId?: string, page: number = 1, limit: number = 50): Promise<ThreadsResponse> => {
  try {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });
    
    const response = await backendApi.get<{ threads: any[]; pagination: any }>(`/threads?${params.toString()}`, {
      showErrors: false,
    });

    if (response.error) {
      console.error('Error getting paginated threads:', response.error);
      handleApiError(response.error, { 
        operation: 'load threads', 
        resource: projectId ? `threads for project ${projectId}` : 'threads' 
      });
      return {
        threads: [],
        pagination: {
          page: 1,
          limit: 50,
          total: 0,
          pages: 0,
        }
      };
    }

    if (!response.data?.threads) {
      return {
        threads: [],
        pagination: response.data?.pagination || {
          page: 1,
          limit: 50,
          total: 0,
          pages: 0,
        }
      };
    }

    let threads = response.data.threads.map((thread: any) => ({
      thread_id: thread.thread_id,
      project_id: thread.project_id,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      metadata: thread.metadata || {},
    }));

    if (projectId) {
      threads = threads.filter((thread: Thread) => thread.project_id === projectId);
    }

    return {
      threads,
      pagination: response.data.pagination || {
        page,
        limit,
        total: threads.length,
        pages: 1,
      }
    };
  } catch (err) {
    console.error('Error fetching paginated threads:', err);
    handleApiError(err, { 
      operation: 'load threads', 
      resource: projectId ? `threads for project ${projectId}` : 'threads' 
    });
    return {
      threads: [],
      pagination: {
        page: 1,
        limit: 50,
        total: 0,
        pages: 0,
      }
    };
  }
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
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('You must be logged in to create a thread');
  }

  const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

  // Use backend API endpoint - it handles project creation as well
  const response = await fetch(`${API_URL}/threads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ project_id: projectId }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    handleApiError(new Error(errorText), { operation: 'create thread', resource: 'thread' });
    throw new Error(errorText);
  }

  const data = await response.json();
  return data;
};

export class NoAccessTokenAvailableError extends Error {
  constructor() {
    super('No access token available');
    this.name = 'NoAccessTokenAvailableError';
  }
}

export const addUserMessage = async (
  threadId: string,
  content: string,
): Promise<void> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new NoAccessTokenAvailableError();
    }

    const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

    // Use backend API endpoint with auth handling
    const response = await fetch(`${API_URL}/threads/${threadId}/messages/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ message: content }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('Error adding user message:', errorText);
      handleApiError(new Error(errorText), { operation: 'add message', resource: 'message' });
      throw new Error(`Error adding message: ${errorText}`);
    }
  } catch (error) {
    if (error instanceof NoAccessTokenAvailableError) {
      throw error;
    }
    console.error('Failed to add user message:', error);
    handleApiError(error, { operation: 'add message', resource: 'message' });
    throw error;
  }
};

export const getMessages = async (threadId: string): Promise<Message[]> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

    // Build headers with optional auth token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    // Use backend API endpoint with auth handling
    // Backend handles batching internally and returns all messages
    const response = await fetch(`${API_URL}/threads/${threadId}/messages?order=asc`, {
      headers,
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('Error fetching messages:', errorText);
      handleApiError(new Error(errorText), { operation: 'load messages', resource: `messages for thread ${threadId}` });
      throw new Error(`Error getting messages: ${errorText}`);
    }

    const data = await response.json();
    const allMessages = data.messages || [];

    // Filter out cost and summary messages (backend doesn't filter these)
    const filteredMessages = allMessages.filter(
      (msg: Message) => msg.type !== 'cost' && msg.type !== 'summary'
    );

    // Extract context_usage from the latest llm_response_end message
    try {
      const llmResponseEndMessages = filteredMessages.filter((msg: Message) => msg.type === 'llm_response_end');
      
      // Find the most recent llm_response_end message
      if (llmResponseEndMessages.length > 0) {
        const latestMsg = llmResponseEndMessages[llmResponseEndMessages.length - 1];
        try {
          const content = typeof latestMsg.content === 'string' ? JSON.parse(latestMsg.content) : latestMsg.content;
          if (content?.usage?.total_tokens) {
            // Store context usage
            const { useContextUsageStore } = await import('@/stores/context-usage-store');
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

    return filteredMessages;
  } catch (error) {
    console.error('Failed to get messages:', error);
    handleApiError(error, { operation: 'load messages', resource: `messages for thread ${threadId}` });
    throw error;
  }
};

