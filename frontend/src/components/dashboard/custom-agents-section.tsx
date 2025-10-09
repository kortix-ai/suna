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
import { UnifiedAgentCard } from '@/components/ui/unified-agent-card';
import type { BaseAgentData } from '@/components/ui/unified-agent-card';

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
      system_prompt: template.system_prompt,
      tags: template.tags || [],
      download_count: template.download_count || 0,
      is_kortix_team: template.is_kortix_team || false,
      creator_name: template.creator_name,
      created_at: template.created_at,
      icon_name: template.icon_name,
      icon_color: template.icon_color,
      icon_background: template.icon_background,
      mcp_requirements: template.mcp_requirements || [],
      agentpress_tools: template.agentpress_tools || {},
      model: template.metadata?.model,
      marketplace_published_at: template.marketplace_published_at,
      usage_examples: template.usage_examples,
      config: template.config,
    };

    setSelectedTemplate(marketplaceTemplate);
    setIsPreviewOpen(true);
  };

  // Convert template to BaseAgentData
  const convertTemplateToAgentData = (template: any): BaseAgentData => ({
    id: template.template_id,
    name: template.name,
    description: template.description,
    tags: template.tags || [],
    created_at: template.created_at,
    icon_name: template.icon_name,
    icon_color: template.icon_color,
    icon_background: template.icon_background,
    creator_id: template.creator_id,
    creator_name: template.creator_name,
    is_kortix_team: template.is_kortix_team || false,
    download_count: template.download_count || 0,
    marketplace_published_at: template.marketplace_published_at,
  });

  const handlePreviewInstall = (agent: MarketplaceTemplate) => {
    setIsPreviewOpen(false);
    setSelectedTemplate(agent);
    setShowInstallDialog(true);
  };

  const handleInstall = async (
    item: MarketplaceTemplate, 
    instanceName: string, 
    profileMappings: Record<string, string>, 
    customServerConfigs: Record<string, any>,
    triggerConfigs?: Record<string, Record<string, any>>,
    triggerVariables?: Record<string, Record<string, string>>
  ) => {
    if (!item) return;

    setInstallingItemId(item.id);

    try {
      const result = await installTemplate.mutateAsync({
        template_id: item.id,
        instance_name: instanceName,
        profile_mappings: profileMappings,
        custom_mcp_configs: customServerConfigs,
        trigger_configs: triggerConfigs,
        trigger_variables: triggerVariables,
      });

      if (result.status === 'installed' && result.instance_id) {
        toast.success(`Agent "${instanceName}" installed successfully!`);
        setShowInstallDialog(false);
        
        if (onAgentSelect) {
          onAgentSelect(result.instance_id);
        }
      } else if (result.status === 'configs_required') {
        if (result.missing_trigger_variables && Object.keys(result.missing_trigger_variables).length > 0) {
          toast.warning('Please provide values for template trigger variables.');
          setInstallingItemId('');
          return;
        }
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
            <div key={i} className="bg-muted/30 rounded-3xl p-4 h-auto w-full flex items-center">
              <Skeleton className="w-12 h-12 rounded-xl" />
              <Skeleton className="h-6 w-1/2 ml-4" />
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
          {templates.templates.map((template) => (
            <UnifiedAgentCard
              key={template.template_id}
              variant="dashboard"
              data={convertTemplateToAgentData(template)}
              actions={{
                onClick: () => handleCardClick(template)
              }}
            />
          ))}
        </div>
      </div>
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