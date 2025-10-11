'use client';

import React, { useState } from 'react';
import { Bot, FileEdit, Globe } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCreateNewAgent } from '@/hooks/react-query/agents/use-agents';
import { useKortixTeamTemplates } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { AgentCountLimitError } from '@/lib/api';
import { toast } from 'sonner';
import { AgentCountLimitDialog } from './agent-count-limit-dialog';
import { UnifiedAgentCard } from '@/components/ui/unified-agent-card';
import type { BaseAgentData } from '@/components/ui/unified-agent-card';
import type { MarketplaceTemplate } from './installation/types';
import { MarketplaceAgentPreviewDialog } from './marketplace-agent-preview-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';

interface AgentCreationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (agentId: string) => void;
}

export function AgentCreationModal({ open, onOpenChange, onSuccess }: AgentCreationModalProps) {
  const router = useRouter();
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitError, setAgentLimitError] = useState<any>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<MarketplaceTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const createNewAgentMutation = useCreateNewAgent();
  const { data: templates, isLoading } = useKortixTeamTemplates();

  const displayTemplates = templates?.templates?.slice(0, 6) || [];

  const handleCreateFromScratch = () => {
    createNewAgentMutation.mutate(undefined, {
      onSuccess: (newAgent) => {
        onOpenChange(false);
        onSuccess?.(newAgent.agent_id);
      },
      onError: (error) => {
        if (error instanceof AgentCountLimitError) {
          setAgentLimitError(error.detail);
          setShowAgentLimitDialog(true);
          onOpenChange(false);
        } else {
          toast.error(error instanceof Error ? error.message : 'Failed to create agent');
        }
      }
    });
  };

  const handleExploreTemplates = () => {
    onOpenChange(false);
    router.push('/dashboard?tab=worker-templates');
  };

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
    onOpenChange(false);
    setIsPreviewOpen(true);
  };

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
    mcp_requirements: template.mcp_requirements || [],
    agentpress_tools: template.agentpress_tools || {},
  });

  const handlePreviewInstall = () => {
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>What would you like to automate?</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {isLoading ? (
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="bg-muted/30 rounded-3xl p-4 h-auto w-full flex items-center">
                    <Skeleton className="w-12 h-12 rounded-xl" />
                    <Skeleton className="h-6 w-1/2 ml-4" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {displayTemplates.map((template) => (
                  <UnifiedAgentCard
                    key={template.template_id}
                    variant="compact"
                    data={convertTemplateToAgentData(template)}
                    actions={{
                      onClick: () => handleCardClick(template)
                    }}
                  />
                ))}
              </div>
            )}
            <div className="flex items-center justify-start gap-3 pt-4">
              <Button
                variant="default"
                onClick={handleCreateFromScratch}
                disabled={createNewAgentMutation.isPending}
                className="gap-2"
              >
                <Bot className="h-4 w-4" />
                Create from scratch
              </Button>
              <Button
                variant="outline"
                onClick={handleExploreTemplates}
                className="gap-2"
              >
                <Globe className="h-4 w-4" />
                Explore templates
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <MarketplaceAgentPreviewDialog
        agent={selectedTemplate}
        isOpen={isPreviewOpen}
        onClose={() => {
          setIsPreviewOpen(false);
          setSelectedTemplate(null);
        }}
        onInstall={handlePreviewInstall}
        isInstalling={false}
      />

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

