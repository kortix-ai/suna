import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface AgentExportData {
  name: string;
  description?: string;
  system_prompt: string;
  agentpress_tools: Record<string, any>;
  configured_mcps: Array<{
    name: string;
    config: Record<string, any>;
  }>;
  custom_mcps: Array<{
    name: string;
    type: 'json' | 'sse';
    config: Record<string, any>;
    enabledTools: string[];
  }>;
  tags?: string[];
  metadata?: Record<string, any>;
  export_version: string;
  exported_at: string;
  exported_by?: string;
}

export interface AgentImportRequest {
  import_data: AgentExportData;
  import_as_new: boolean;
}

// Export agent hook
export const useExportAgent = () => {
  return useMutation({
    mutationFn: async (agentId: string): Promise<AgentExportData> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to export agents');
      }

      const response = await fetch(`${API_URL}/agents/${agentId}/export`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    },
    onSuccess: (data, agentId) => {
      // Create and download JSON file
      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `${data.name.replace(/[^a-zA-Z0-9]/g, '_')}_agent_export.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      toast.success(`Agent "${data.name}" exported successfully`);
    },
    onError: (error: any) => {
      console.error('Export error:', error);
      toast.error(error?.message || "Failed to export agent");
    },
  });
};

// Import agent hook
export const useImportAgent = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (importRequest: AgentImportRequest) => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to import agents');
      }

      const response = await fetch(`${API_URL}/agents/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(importRequest),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    },
    onSuccess: (data, variables) => {
      // Invalidate agents list to refresh data
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      
      const action = variables.import_as_new ? 'imported' : 'updated';
      toast.success(`Agent "${variables.import_data.name}" ${action} successfully`);
    },
    onError: (error: any) => {
      console.error('Import error:', error);
      toast.error(error?.message || "Failed to import agent");
    },
  });
};

// Helper function to validate import data
export const validateImportData = (data: any): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  
  if (!data) {
    errors.push("No data provided");
    return { isValid: false, errors };
  }
  
  if (!data.name || typeof data.name !== 'string') {
    errors.push("Agent name is required");
  }
  
  if (!data.system_prompt || typeof data.system_prompt !== 'string') {
    errors.push("System prompt is required");
  }
  
  if (!data.export_version) {
    errors.push("Export version is missing - this may not be a valid agent export file");
  }
  
  if (data.agentpress_tools && typeof data.agentpress_tools !== 'object') {
    errors.push("Invalid agentpress_tools format");
  }
  
  if (data.configured_mcps && !Array.isArray(data.configured_mcps)) {
    errors.push("Invalid configured_mcps format");
  }
  
  if (data.custom_mcps && !Array.isArray(data.custom_mcps)) {
    errors.push("Invalid custom_mcps format");
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// Helper function to read and parse JSON file
export const parseAgentImportFile = (file: File): Promise<AgentExportData> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        
        const validation = validateImportData(data);
        if (!validation.isValid) {
          reject(new Error(`Invalid import file: ${validation.errors.join(', ')}`));
          return;
        }
        
        resolve(data as AgentExportData);
      } catch (error) {
        reject(new Error('Failed to parse JSON file'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    reader.readAsText(file);
  });
};