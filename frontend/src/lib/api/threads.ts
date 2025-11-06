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
      account_id: user.id,
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

  const message = {
    role: 'user',
    content: content,
  };

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

  try {
    const llmResponseEndMessages = allMessages.filter(msg => msg.type === 'llm_response_end');
    
    if (llmResponseEndMessages.length > 0) {
      const latestMsg = llmResponseEndMessages[llmResponseEndMessages.length - 1];
      try {
        const content = typeof latestMsg.content === 'string' ? JSON.parse(latestMsg.content) : latestMsg.content;
        if (content?.usage?.total_tokens) {
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

  return allMessages;
};

