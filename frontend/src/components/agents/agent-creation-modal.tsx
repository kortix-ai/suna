'use client';

import React, { useState } from 'react';
import { Bot, FileEdit, Globe, Hammer, LayoutTemplate, Wrench, MessageSquare } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCreateNewAgent } from '@/hooks/agents/use-agents';
import { useKortixTeamTemplates } from '@/hooks/secure-mcp/use-secure-mcp';
import { AgentCountLimitError } from '@/lib/api/errors';
import { toast } from 'sonner';
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
  const [selectedTemplate, setSelectedTemplate] = useState<MarketplaceTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<'scratch' | 'chat' | 'template' | null>(null);
  const [showChatStep, setShowChatStep] = useState(false);
  const [chatDescription, setChatDescription] = useState('');

  const createNewAgentMutation = useCreateNewAgent();
  // Only fetch templates when modal is open to avoid unnecessary API calls
  const { data: templates, isLoading } = useKortixTeamTemplates({ enabled: open });

  const displayTemplates = templates?.templates?.slice(0, 6) || [];

  const handleCreateFromScratch = () => {
    createNewAgentMutation.mutate(undefined, {
      onSuccess: (newAgent) => {
        onOpenChange(false);
        onSuccess?.(newAgent.agent_id);
      },
      onError: (error) => {
        if (error instanceof AgentCountLimitError) {
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

  const handleOptionClick = (option: 'scratch' | 'chat' | 'template') => {
    setSelectedOption(option);

    // Navigate immediately based on selection
    if (option === 'scratch') {
      // Create agent and redirect to its config screen
      createNewAgentMutation.mutate(undefined, {
        onSuccess: (newAgent) => {
          onOpenChange(false);
          router.push(`/agents/config/${newAgent.agent_id}`);
        },
        onError: (error) => {
          if (error instanceof AgentCountLimitError) {
            onOpenChange(false);
          } else {
            toast.error(error instanceof Error ? error.message : 'Failed to create agent');
          }
        }
      });
    } else if (option === 'chat') {
      // Show chat configuration step
      setShowChatStep(true);
    } else if (option === 'template') {
      // Open templates tab
      handleExploreTemplates();
    }
  };

  const handleChatContinue = async () => {
    if (!chatDescription.trim()) {
      toast.error('Please describe what your Worker should be able to do');
      return;
    }

    try {
      const { setupAgentFromChat } = await import('@/lib/api/agents');

      toast.loading('Creating your worker with AI...', { id: 'agent-setup' });

      const result = await setupAgentFromChat({
        description: chatDescription
      });

      toast.success(`Created "${result.name}"!`, { id: 'agent-setup' });
      onOpenChange(false);
      router.push(`/agents/config/${result.agent_id}`);

    } catch (error: any) {
      toast.error('Failed to create agent', { id: 'agent-setup' });
      if (error?.detail?.error_code === 'AGENT_LIMIT_EXCEEDED') {
        onOpenChange(false);
      } else {
        console.error('Error creating agent from chat:', error);
      }
    }
  };

  const handleBack = () => {
    setShowChatStep(false);
    setSelectedOption(null);
    setChatDescription('');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl" hideCloseButton>
          {!showChatStep ? (
            <>
              <DialogHeader className="text-center pb-8 flex items-center justify-center pt-6">
                <DialogTitle className="text-3xl font-medium">Let's get started with your new Worker.</DialogTitle>
              </DialogHeader>

              <div className="flex flex-col items-center gap-6 py-4 pb-8">
                {[
                  { id: 'scratch' as const, icon: Wrench, label: 'Configure Manually' },
                  { id: 'chat' as const, icon: MessageSquare, label: 'Configure by Chat' },
                  { id: 'template' as const, icon: Globe, label: 'Explore Templates' }
                ].map((option, index) => {
                  const Icon = option.icon;
                  const isTopRow = index < 2;

                  if (index === 0) {
                    return (
                      <div key="top-row" className="flex gap-6">
                        {[
                          { id: 'scratch' as const, icon: Wrench, label: 'Configure Manually' },
                          { id: 'chat' as const, icon: MessageSquare, label: 'Configure by Chat' }
                        ].map((topOption) => {
                          const TopIcon = topOption.icon;
                          return (
                            <button
                              key={topOption.id}
                              onClick={() => handleOptionClick(topOption.id)}
                              disabled={createNewAgentMutation.isPending}
                              className={`flex-1 min-w-[380px] h-[144px] rounded-3xl border transition-all ${selectedOption === topOption.id
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-card hover:bg-muted/30'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              <div className="flex flex-col items-center justify-center gap-4 h-full">
                                <TopIcon className="h-8 w-8" />
                                <span className="text-2xl font-medium">{topOption.label}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  }

                  if (index === 2) {
                    return (
                      <button
                        key={option.id}
                        onClick={() => handleOptionClick(option.id)}
                        disabled={createNewAgentMutation.isPending}
                        className={`min-w-[380px] h-[144px] rounded-3xl border transition-all ${selectedOption === option.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card hover:bg-muted/30'
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        <div className="flex flex-col items-center justify-center gap-4 h-full">
                          <Icon className="h-8 w-8" />
                          <span className="text-2xl font-medium">{option.label}</span>
                        </div>
                      </button>
                    );
                  }

                  return null;
                })}
              </div>
            </>
          ) : (
            <>
              <DialogHeader className="text-center pb-8 flex items-center justify-center pt-6">
                <DialogTitle className="text-3xl font-medium">What should your Worker be able to do?</DialogTitle>
              </DialogHeader>

              <div className="flex flex-col gap-6 px-8 py-4 pb-2">
                <textarea
                  value={chatDescription}
                  onChange={(e) => setChatDescription(e.target.value)}
                  placeholder="Describe your new Worker in a few simple sentences."
                  className="w-full min-h-[200px] p-4 rounded-2xl border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-primary text-base"
                  autoFocus
                />

                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    onClick={handleBack}
                    disabled={createNewAgentMutation.isPending}
                  >
                    Back
                  </Button>

                  <Button
                    onClick={handleChatContinue}
                    disabled={!chatDescription.trim() || createNewAgentMutation.isPending}
                  >
                    Continue
                  </Button>
                </div>
              </div>
            </>
          )}
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
    </>
  );
}

