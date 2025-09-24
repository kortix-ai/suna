import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { backendApi } from '@/lib/api-client';

interface JsonAnalysisRequest {
  json_data: Record<string, any>;
}

interface JsonAnalysisResult {
  requires_setup: boolean;
  missing_regular_credentials?: Array<{
    qualified_name: string;
    display_name: string;
    description?: string;
    custom_type?: string;
    app_slug?: string;
    toolkit_slug?: string;
  }>;
  missing_custom_configs?: Array<{
    qualified_name: string;
    display_name: string;
    description?: string;
    custom_type?: string;
    app_slug?: string;
    toolkit_slug?: string;
  }>;
  agent_info: {
    name: string;
    description?: string;
  };
}

interface JsonImportRequest {
  json_data: Record<string, any>;
  instance_name?: string;
  custom_system_prompt?: string;
  profile_mappings?: Record<string, string>;
  custom_mcp_configs?: Record<string, Record<string, any>>;
}

interface JsonImportResult {
  status: string;
  instance_id?: string;
  name?: string;
  missing_regular_credentials?: any[];
  missing_custom_configs?: any[];
  agent_info?: any;
}

export const useAnalyzeJsonForImport = () => {
  return useMutation<JsonAnalysisResult, Error, JsonAnalysisRequest>({
    mutationFn: async (request) => {
      try {
        const response = await backendApi.post('/agents/json/analyze', request);
        return response.data;
      } catch (error: any) {
        const message = error.response?.data?.detail || error.message || 'Failed to analyze JSON';
        throw new Error(message);
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
};

export const useImportAgentFromJson = () => {
  return useMutation<JsonImportResult, Error, JsonImportRequest>({
    mutationFn: async (request) => {
      try {
        const response = await backendApi.post('/agents/json/import', request);
        return response.data;
      } catch (error: any) {
        const errorData = error.response?.data;
        const isAgentLimitError = (error.response?.status === 402) && (
          errorData?.error_code === 'AGENT_LIMIT_EXCEEDED' || 
          errorData?.detail?.error_code === 'AGENT_LIMIT_EXCEEDED'
        );
        
        if (isAgentLimitError) {
          const { AgentCountLimitError } = await import('@/lib/api');
          const errorDetail = errorData?.detail || errorData;
          throw new AgentCountLimitError(error.response.status, errorDetail);
        }
        
        const message = error.response?.data?.detail || error.message || 'Failed to import agent';
        throw new Error(message);
      }
    },
    onSuccess: (data) => {
      if (data?.status === 'success') {
        toast.success('Agent imported successfully!');
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
};

export type { JsonAnalysisRequest, JsonAnalysisResult, JsonImportRequest, JsonImportResult }; 