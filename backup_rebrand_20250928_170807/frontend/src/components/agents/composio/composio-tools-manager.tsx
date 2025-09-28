import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useComposioProfiles } from '@/hooks/react-query/composio/use-composio-profiles';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';
import { backendApi } from '@/lib/api-client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { composioApi } from '@/hooks/react-query/composio/utils';
import { ComposioToolsSelector } from './composio-tools-selector';

interface ComposioToolsManagerProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId?: string;
  profileInfo?: {
    profile_id: string;
    profile_name: string;
    toolkit_name: string;
    toolkit_slug: string;
  };
  appLogo?: string;
  onToolsUpdate?: () => void;
}



export const ComposioToolsManager: React.FC<ComposioToolsManagerProps> = ({
  agentId,
  open,
  onOpenChange,
  profileId,
  profileInfo,
  onToolsUpdate,
  appLogo,
}) => {
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const queryClient = useQueryClient();
  const { data: profiles } = useComposioProfiles();

  const currentProfile = profileInfo || profiles?.find(p => p.profile_id === profileId);
  const { data: iconData } = useComposioToolkitIcon(currentProfile?.toolkit_slug || '', {
    enabled: !!currentProfile?.toolkit_slug
  });

  // Load current tools when dialog opens
  useEffect(() => {
    const loadCurrentTools = async () => {
      if (!open || !agentId || !profileId) return;

      try {
        const response = await backendApi.get(`/agents/${agentId}`);
        if (response.success && response.data) {
          const agent = response.data;
          const composioMcps = agent.custom_mcps?.filter((mcp: any) =>
            mcp.type === 'composio' && mcp.config?.profile_id === profileId
          ) || [];

          const enabledTools = composioMcps.flatMap((mcp: any) => mcp.enabledTools || []);
          setSelectedTools(enabledTools);
        }
      } catch (error) {
        console.error('Failed to load current tools:', error);
        setSelectedTools([]);
      }
    };

    if (open) {
      loadCurrentTools();
    } else {
      // Reset when dialog closes
      setSelectedTools([]);
    }
  }, [open, agentId, profileId]);

  const handleSave = async () => {
    if (!currentProfile) return;

    try {
      const mcpConfigResponse = await composioApi.getMcpConfigForProfile(currentProfile.profile_id);
      const response = await backendApi.put(`/agents/${agentId}/custom-mcp-tools`, {
        custom_mcps: [{
          ...mcpConfigResponse.mcp_config,
          enabledTools: selectedTools
        }]
      });
      
      if (response?.data?.success) {
        toast.success(`Added ${selectedTools.length} ${currentProfile.toolkit_name} tools to your agent!`);
        onToolsUpdate?.();
        onOpenChange(false);
      } else {
        throw new Error('Failed to update tools');
      }
    } catch (error: any) {
      console.error('Failed to save tools:', error);
      
      if (error.response?.status === 403) {
        toast.error('Access denied. Please check your permissions.');
      } else if (error.response?.status === 404) {
        toast.error('Agent not found');
      } else if (error.response?.data?.detail) {
        toast.error(error.response.data.detail);
      } else {
        toast.error('Failed to save tools. Please try again.');
      }
    }
  };

  if (!currentProfile) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[80vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="p-6 pb-4 border-b flex-shrink-0">
          <div className="flex items-center gap-3">
            {iconData?.icon_url || appLogo ? (
              <img
                src={iconData?.icon_url || appLogo}
                alt={currentProfile?.toolkit_name}
                className="w-10 h-10 rounded-lg border object-contain bg-muted p-1"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary font-semibold">
                {currentProfile?.toolkit_name?.charAt(0) || 'T'}
              </div>
            )}
            <div className="flex-1">
              <DialogTitle className="text-lg font-semibold">
                Configure {currentProfile?.toolkit_name} Tools
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Select tools to add to your agent
              </p>
            </div>
          </div>
        </DialogHeader>

        <ComposioToolsSelector
          profileId={currentProfile.profile_id}
          agentId={agentId}
          toolkitName={currentProfile.toolkit_name}
          toolkitSlug={currentProfile.toolkit_slug}
          selectedTools={selectedTools}
          onToolsChange={setSelectedTools}
          onSave={handleSave}
          onCancel={() => onOpenChange(false)}
          className="flex-1 min-h-0"
        />
      </DialogContent>
    </Dialog>
  );
}; 