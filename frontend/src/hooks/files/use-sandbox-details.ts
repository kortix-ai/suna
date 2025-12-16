import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { sandboxKeys } from './keys';

export interface SandboxDetails {
  sandbox_id: string;
  state: string;
  project_id: string;
  vnc_preview?: string;
  sandbox_url?: string;
  created_at?: string;
  updated_at?: string;
  target?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  labels?: Record<string, string>;
}

interface SandboxDetailsResponse {
  status: string;
  sandbox: SandboxDetails;
}

export function useSandboxDetails(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<SandboxDetails | null>({
    queryKey: sandboxKeys.details(projectId || ''),
    queryFn: async () => {
      if (!projectId) return null;
      
      const response = await backendApi.get<SandboxDetailsResponse>(
        `/project/${projectId}/sandbox`,
        { showErrors: false }
      );

      console.log('Sandbox Details Response:', response.data);
      
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to fetch sandbox details');
      }
      
      return response.data.sandbox;
    },
    enabled: !!projectId && (options?.enabled !== false),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}
