import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { backendApi } from '@/lib/api-client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export interface TriggerWithAgent {
  trigger_id: string;
  agent_id: string;
  trigger_type: string;
  provider_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  config?: Record<string, any>;
  agent_name?: string;
  agent_description?: string;
  icon_name?: string;
  icon_color?: string;
  icon_background?: string;
  profile_image_url?: string;
}

const fetchAllTriggers = async (): Promise<TriggerWithAgent[]> => {
  const response = await backendApi.get<TriggerWithAgent[]>(`/triggers/all`);
  if (!response.success) {
    const error = response.error?.message || 'Failed to fetch triggers';
    throw new Error(error || 'Failed to fetch triggers');
  }
  return response.data;
};

export const useAllTriggers = () => {
  return useQuery({
    queryKey: ['all-triggers'],
    queryFn: fetchAllTriggers,
    staleTime: 1 * 60 * 1000,
    refetchInterval: 30 * 1000,
  });
}; 