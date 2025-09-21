'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Ripple } from '../ui/ripple';
import { useKortixTeamTemplates, useInstallTemplate } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';
import { MarketplaceAgentPreviewDialog } from '@/components/agents/marketplace-agent-preview-dialog';
import { StreamlinedInstallDialog } from '@/components/agents/installation/streamlined-install-dialog';
import { toast } from 'sonner';
import { AgentCountLimitDialog } from '@/components/agents/agent-count-limit-dialog';
import type { MarketplaceTemplate } from '@/components/agents/installation/types';
import { AgentCountLimitError } from '@/lib/api';
import { AgentIconAvatar } from '@/components/agents/config/agent-icon-avatar';

interface CustomAgentsSectionProps {
  onAgentSelect?: (templateId: string) => void;
}

const TitleSection = () => (
  <div className="mb-6 mt-6 text-center">
    <h3 className="text-lg font-medium text-foreground/90 mb-1">
      Choose specialised agent
    </h3>
    <p className="text-sm text-muted-foreground/70">
      Ready-to-use AI agents for specific tasks
    </p>
  </div>
);

export function CustomAgentsSection({ onAgentSelect }: CustomAgentsSectionProps) {
  const router = useRouter();
  const { data: templates, isLoading, error } = useKortixTeamTemplates();
  const installTemplate = useInstallTemplate();
  
  const [selectedTemplate, setSelectedTemplate] = React.useState<MarketplaceTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [showInstallDialog, setShowInstallDialog] = React.useState(false);
  const [showAgentLimitDialog, setShowAgentLimitDialog] = React.useState(false);
  const [agentLimitError, setAgentLimitError] = React.useState<any>(null);
  const [installingItemId, setInstallingItemId] = React.useState<string | null>(null);

  const handleCardClick = (template: any) => {
    const marketplaceTemplate: MarketplaceTemplate = {
      id: template.template_id,
      template_id: template.template_id,
      creator_id: template.creator_id,
      name: template.name,
      description: template.description,
      tags: template.tags || [],
      download_count: template.download_count || 0,
      is_kortix_team: template.is_kortix_team || false,
      creator_name: template.creator_name,
      created_at: template.created_at,
      profile_image_url: template.profile_image_url,
      icon_name: template.icon_name,
      icon_color: template.icon_color,
      icon_background: template.icon_background,
      mcp_requirements: template.mcp_requirements || [],
      agentpress_tools: template.agentpress_tools || {},
      model: template.metadata?.model,
      marketplace_published_at: template.marketplace_published_at,
    };
    
    setSelectedTemplate(marketplaceTemplate);
    setIsPreviewOpen(true);
  };

  const handlePreviewInstall = (agent: MarketplaceTemplate) => {
    setIsPreviewOpen(false);
    setSelectedTemplate(agent);
    setShowInstallDialog(true);
  };

  // Handle the actual installation from the streamlined dialog
  const handleInstall = async (
    item: MarketplaceTemplate, 
    instanceName: string, 
    profileMappings: Record<string, string>, 
    customServerConfigs: Record<string, any>
  ) => {
    if (!item) return;

    setInstallingItemId(item.id);

    try {
      const result = await installTemplate.mutateAsync({
        template_id: item.id,
        instance_name: instanceName,
        profile_mappings: profileMappings,
        custom_mcp_configs: customServerConfigs,
      });

      if (result.status === 'installed' && result.instance_id) {
        toast.success(`Agent "${instanceName}" installed successfully!`);
        setShowInstallDialog(false);
        
        if (onAgentSelect) {
          onAgentSelect(result.instance_id);
        }
      } else if (result.status === 'configs_required') {
        toast.error('Please provide all required configurations');
        return;
      } else {
        toast.error('Unexpected response from server. Please try again.');
        return;
      }
    } catch (error: any) {
      console.error('Installation error:', error);

      if (error instanceof AgentCountLimitError) {
        setAgentLimitError(error.detail);
        setShowAgentLimitDialog(true);
        setShowInstallDialog(false);
        return;
      }

      if (error.message?.includes('already in your library')) {
        toast.error('This agent is already in your library');
      } else if (error.message?.includes('Credential profile not found')) {
        toast.error('One or more selected credential profiles could not be found. Please refresh and try again.');
      } else if (error.message?.includes('Missing credential profile')) {
        toast.error('Please select credential profiles for all required services');
      } else if (error.message?.includes('Invalid credential profile')) {
        toast.error('One or more selected credential profiles are invalid. Please select valid profiles.');
      } else if (error.message?.includes('inactive')) {
        toast.error('One or more selected credential profiles are inactive. Please select active profiles.');
      } else if (error.message?.includes('Template not found')) {
        toast.error('This agent template is no longer available');
      } else if (error.message?.includes('Access denied')) {
        toast.error('You do not have permission to install this agent');
      } else {
        toast.error(error.message || 'Failed to install agent. Please try again.');
      }
    } finally {
      setInstallingItemId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="grid gap-4 pb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="bg-muted/30 rounded-3xl p-4 h-[180px] w-full">
              <Skeleton className="h-12 w-12 rounded-2xl mb-3" />
              <Skeleton className="h-5 w-3/4 mb-2" />
              <Skeleton className="h-10 w-full mb-3" />
              <Skeleton className="h-8 w-full mt-auto" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="text-center py-8">
          <p className="text-muted-foreground">Failed to load custom agents</p>
        </div>
      </div>
    );
  }

  // No agents found
  if (!templates || !templates.templates || templates.templates.length === 0) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="text-center py-8">
          <p className="text-muted-foreground">No custom agents available yet</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="w-full">
        <TitleSection />
        <div className="grid gap-4 pb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {templates.templates.slice(0, 4).map((template) => (
            <div
              key={template.template_id}
              className={cn(
                'group relative bg-muted/30 rounded-3xl overflow-hidden transition-all duration-300 border cursor-pointer flex flex-col h-[180px] w-full border-border/50',
                'hover:border-primary/20'
              )}
              onClick={() => handleCardClick(template)}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              
              <div className="h-full relative flex flex-col overflow-hidden w-full p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-shrink-0">
                    <AgentIconAvatar
                      profileImageUrl={template.profile_image_url}
                      iconName={template.icon_name}
                      iconColor={template.icon_color}
                      backgroundColor={template.icon_background}
                      agentName={template.name}
                      size={40}
                      className="shadow-md"
                    />
                  </div>
                  <h3 className="text-base font-semibold text-foreground line-clamp-1 flex-1 min-w-0">
                    {template.name}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed flex-1">
                  {template.description || 'No description available'}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Marketplace Preview Dialog */}
      <MarketplaceAgentPreviewDialog
        agent={selectedTemplate}
        isOpen={isPreviewOpen}
        onClose={() => {
          setIsPreviewOpen(false);
          setSelectedTemplate(null);
        }}
        onInstall={handlePreviewInstall}
        isInstalling={installingItemId === selectedTemplate?.id}
      />

      {/* Streamlined Install Dialog */}
      <StreamlinedInstallDialog
        item={selectedTemplate}
        open={showInstallDialog}
        onOpenChange={setShowInstallDialog}
        onInstall={handleInstall}
        isInstalling={installingItemId === selectedTemplate?.id}
      />

      {/* Agent Limit Dialog */}
      {showAgentLimitDialog && agentLimitError && (
        <AgentCountLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          currentCount={agentLimitError.current_count}
          limit={agentLimitError.limit}
          tierName={agentLimitError.tier_name}
        />
      )}
    </>
  );
} 