import { Project, Thread } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

export const getThread = async (threadId: string): Promise<Thread> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('threads')
    .select('*')
    .eq('thread_id', threadId)
    .single();

  if (error) throw error;

  return data;
};

export const getProject = async (projectId: string): Promise<Project> => {
  const supabase = await createClient();

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

    // // If project has a sandbox, ensure it's started
    // if (data.sandbox?.id) {
    //   // Fire off sandbox activation without blocking
    //   const ensureSandboxActive = async () => {
    //     try {
    //       const {
    //         data: { session },
    //       } = await supabase.auth.getSession();

    //       // For public projects, we don't need authentication
    //       const headers: Record<string, string> = {
    //         'Content-Type': 'application/json',
    //       };

    //       if (session?.access_token) {
    //         headers['Authorization'] = `Bearer ${session.access_token}`;
    //       }

    //       const response = await fetch(
    //         `${API_URL}/project/${projectId}/sandbox/ensure-active`,
    //         {
    //           method: 'POST',
    //           headers,
    //         },
    //       );

    //       if (!response.ok) {
    //         const errorText = await response
    //           .text()
    //           .catch(() => 'No error details available');
    //         console.warn(
    //           `Failed to ensure sandbox is active: ${response.status} ${response.statusText}`,
    //           errorText,
    //         );
    //       }
    //     } catch (sandboxError) {
    //       console.warn('Failed to ensure sandbox is active:', sandboxError);
    //     }
    //   };

    //   // Start the sandbox activation without awaiting
    //   ensureSandboxActive();
    // }

    // Map database fields to our Project type
    const mappedProject: Project = {
      id: data.project_id,
      name: data.name || '',
      description: data.description || '',
      is_public: data.is_public || false,
      created_at: data.created_at,
      sandbox: data.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    };
    return mappedProject;
  } catch (error) {
    console.error(`Error fetching project ${projectId}:`, error);
    throw error;
  }
};