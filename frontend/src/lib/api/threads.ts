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

// Project type and API functions (moved from projects.ts)
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
  is_public?: boolean;
  icon_name?: string | null;
  [key: string]: any;
};

// Direct API call for getting a project - used by React Query hooks
export const getProject = async (projectId: string): Promise<Project> => {
  const response = await backendApi.get<{
    project_id: string;
    name: string;
    description: string;
    created_at: string;
    updated_at?: string;
    sandbox: any;
    is_public?: boolean;
    icon_name?: string | null;
  }>(`/projects/${projectId}`, {
    showErrors: true
  });

  if (response.error) {
    handleApiError(response.error, { operation: 'load project', resource: `project ${projectId}` });
    throw new Error(response.error.message || `Project not found: ${projectId}`);
  }

  if (!response.data) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const projectData = response.data;

  // Map backend response to frontend Project type
  return {
    id: projectData.project_id,
    name: projectData.name || '',
    description: projectData.description || '',
    is_public: projectData.is_public || false,
    created_at: projectData.created_at,
    updated_at: projectData.updated_at || projectData.created_at,
    sandbox: projectData.sandbox || {
      id: '',
      pass: '',
      vnc_preview: '',
      sandbox_url: '',
    },
    icon_name: projectData.icon_name,
  };
};

// Delete project (via thread deletion)
export const deleteProject = async (projectId: string): Promise<void> => {
  // Projects are deleted via thread deletion
  // First, find a thread with this project_id
  const threadsResponse = await getThreadsPaginated(undefined, 1, 50);

  if (!threadsResponse?.threads) {
    handleApiError(new Error('Failed to fetch threads'), { operation: 'delete project', resource: `project ${projectId}` });
    throw new Error('Failed to find thread for project');
  }

  const threadWithProject = threadsResponse.threads.find(
    (thread: any) => thread.project_id === projectId
  );

  if (!threadWithProject) {
    throw new Error(`No thread found for project ${projectId}`);
  }

  // Delete the thread (which also deletes the project)
  const deleteResponse = await backendApi.delete(`/threads/${threadWithProject.thread_id}`, {
    showErrors: true,
  });

  if (deleteResponse.error) {
    handleApiError(deleteResponse.error, { operation: 'delete project', resource: `project ${projectId}` });
    throw new Error(deleteResponse.error.message || 'Failed to delete project');
  }
};

// Update project (via thread PATCH endpoint)
export const updateProject = async (
  projectId: string,
  data: Partial<Project>,
): Promise<Project> => {
  if (!projectId || projectId === '') {
    throw new Error('Cannot update project: Invalid project ID');
  }

  // Find thread with this project_id
  const threadsResponse = await getThreadsPaginated(undefined, 1, 50);

  if (!threadsResponse?.threads) {
    throw new Error('Failed to find thread for project');
  }

  const threadWithProject = threadsResponse.threads.find(
    (thread: any) => thread.project_id === projectId
  );

  if (!threadWithProject) {
    throw new Error(`No thread found for project ${projectId}`);
  }

  // Update project via thread PATCH endpoint
  const updatePayload: any = {};
  if (data.name !== undefined) {
    updatePayload.title = data.name;
  }
  if (data.is_public !== undefined) {
    updatePayload.is_public = data.is_public;
  }

  const updateResponse = await backendApi.patch(
    `/threads/${threadWithProject.thread_id}`,
    updatePayload,
    { showErrors: true }
  );

  if (updateResponse.error) {
    throw new Error(updateResponse.error.message || 'Failed to update project');
  }

  // Return updated project data (will be refetched by React Query via invalidation)
  return {
    id: projectId,
    name: data.name !== undefined ? data.name : threadWithProject.project?.name || '',
    description: threadWithProject.project?.description || '',
    is_public: data.is_public !== undefined ? data.is_public : threadWithProject.project?.is_public || false,
    created_at: threadWithProject.project?.created_at || '',
    updated_at: threadWithProject.project?.updated_at,
    sandbox: threadWithProject.project?.sandbox || { id: '', pass: '', vnc_preview: '', sandbox_url: '' },
    icon_name: threadWithProject.project?.icon_name,
  } as Project;
};

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
      project: thread.project, // Preserve project data for getProjects to use
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
  try {
    const response = await backendApi.get<Thread>(`/threads/${threadId}`, {
      showErrors: false,
    });

    if (response.error) {
      handleApiError(response.error, { operation: 'load thread', resource: `thread ${threadId}` });
      throw new Error(response.error.message || 'Failed to fetch thread');
    }

    if (!response.data) {
      throw new Error('Thread not found');
    }

    return response.data;
  } catch (error) {
    handleApiError(error, { operation: 'load thread', resource: `thread ${threadId}` });
    throw error;
  }
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

// Flag to toggle optimized messages endpoint (set to false for debugging, true for production)
const USE_OPTIMIZED_MESSAGES = true;

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
    // optimized=false returns full messages (all types, all fields) for debugging
    // optimized=true returns optimized messages (filtered types, minimal fields) for production
    const response = await fetch(
      `${API_URL}/threads/${threadId}/messages?order=asc&optimized=${USE_OPTIMIZED_MESSAGES}`,
      {
      headers,
      cache: 'no-store',
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('Error fetching messages:', errorText);
      handleApiError(new Error(errorText), { operation: 'load messages', resource: `messages for thread ${threadId}` });
      throw new Error(`Error getting messages: ${errorText}`);
    }

    const data = await response.json();
    const allMessages = data.messages || [];

    // Backend now filters message types, so no need to filter here
    // Backend returns: user, tool, assistant
    // Backend excludes: status, cost, summary, browser_state, image_context, system, llm_response_end

    return allMessages;
  } catch (error) {
    console.error('Failed to get messages:', error);
    handleApiError(error, { operation: 'load messages', resource: `messages for thread ${threadId}` });
    throw error;
  }
};

