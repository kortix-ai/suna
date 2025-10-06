'use client';

import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Bot, Download, Wrench, Plug, Tag, User, Calendar, Loader2, Share, Cpu, Eye, Zap, MessageSquare, ArrowRight, Sparkles, FileText } from 'lucide-react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { toast } from 'sonner';
import type { MarketplaceTemplate, UsageExampleMessage } from '@/components/agents/installation/types';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';
import { useRouter } from 'next/navigation';
import { backendApi } from '@/lib/api-client';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { useTheme } from 'next-themes';
import { Markdown } from '@/components/ui/markdown';

interface MarketplaceAgentPreviewDialogProps {
  agent: MarketplaceTemplate | null;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (agent: MarketplaceTemplate) => void;
  isInstalling?: boolean;
}

const extractAppInfo = (qualifiedName: string, customType?: string) => {
  if (qualifiedName?.startsWith('composio.')) {
    const extractedSlug = qualifiedName.substring(9);
    if (extractedSlug) {
      return { type: 'composio', slug: extractedSlug };
    }
  }
  
  if (customType === 'composio') {
    if (qualifiedName?.startsWith('composio.')) {
      const extractedSlug = qualifiedName.substring(9);
      if (extractedSlug) {
        return { type: 'composio', slug: extractedSlug };
      }
    }
  }
  
  return null;
};

const IntegrationLogo: React.FC<{ 
  qualifiedName: string; 
  displayName: string; 
  customType?: string;
  toolkitSlug?: string;
  size?: 'sm' | 'md' | 'lg';
}> = ({ qualifiedName, displayName, customType, toolkitSlug, size = 'sm' }) => {
  let appInfo = extractAppInfo(qualifiedName, customType);
  
  if (!appInfo && toolkitSlug) {
    appInfo = { type: 'composio', slug: toolkitSlug };
  }
  
  const { data: composioIconData } = useComposioToolkitIcon(
    appInfo?.type === 'composio' ? appInfo.slug : '',
    { enabled: appInfo?.type === 'composio' }
  );
  
  let logoUrl: string | undefined;
  if (appInfo?.type === 'composio') {
    logoUrl = composioIconData?.icon_url;
  }

  const firstLetter = displayName.charAt(0).toUpperCase();

  const sizeClasses = {
    sm: 'w-5 h-5',
    md: 'w-8 h-8',
    lg: 'w-12 h-12'
  };

  return (
    <div className={`${sizeClasses[size]} flex items-center justify-center flex-shrink-0 overflow-hidden rounded-md`}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={displayName}
          className="w-full h-full object-cover"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            target.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <div className={logoUrl ? "hidden" : "flex w-full h-full items-center justify-center bg-muted rounded-md text-xs font-medium text-muted-foreground"}>
        {firstLetter}
      </div>
    </div>
  );
};

export const MarketplaceAgentPreviewDialog: React.FC<MarketplaceAgentPreviewDialogProps> = ({
  agent,
  isOpen,
  onClose,
  onInstall,
  isInstalling = false
}) => {
  const router = useRouter();
  const { theme } = useTheme();
  const [isGeneratingShareLink, setIsGeneratingShareLink] = React.useState(false);
  
  if (!agent) return null;

  const isSunaAgent = agent.is_kortix_team || false;
  
  const tools = agent.mcp_requirements || [];
  
  const toolRequirements = tools.filter(req => req.source === 'tool');
  const triggerRequirements = tools.filter(req => req.source === 'trigger');
  
  const integrations = toolRequirements.filter(tool => !tool.custom_type || tool.custom_type !== 'sse');
  const customTools = toolRequirements.filter(tool => tool.custom_type === 'sse');

  const agentpressTools = Object.entries(agent.agentpress_tools || {})
    .filter(([_, enabled]) => enabled)
    .map(([toolName]) => toolName);

  const handleInstall = () => {
    onInstall(agent);
  };

  const handleShare = async () => {
    setIsGeneratingShareLink(true);
    try {
      // Simple approach: use template ID directly in URL
      const shareUrl = `${window.location.origin}/templates/${agent.template_id}`;
      
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied to clipboard!');
    } catch (error: any) {
      console.error('Failed to copy share link:', error);
      toast.error('Failed to copy share link to clipboard');
    } finally {
      setIsGeneratingShareLink(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const getAppDisplayName = (qualifiedName: string) => {
    if (qualifiedName.includes('_')) {
      const parts = qualifiedName.split('_');
      return parts[parts.length - 1].replace(/\b\w/g, l => l.toUpperCase());
    }
    return qualifiedName.replace(/\b\w/g, l => l.toUpperCase());
  };

  const hasUsageExamples = agent.usage_examples && agent.usage_examples.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className={`${hasUsageExamples ? 'max-w-6xl' : 'max-w-2xl'} h-[85vh] p-0 overflow-hidden flex flex-col`}>
        <DialogHeader className='sr-only'>
          <DialogTitle>Agent Preview</DialogTitle>
        </DialogHeader>
        <div className={`flex ${hasUsageExamples ? 'flex-row' : 'flex-col'} flex-1 min-h-0`}>
          <div className={`${hasUsageExamples ? 'w-1/2' : 'w-full'} flex flex-col min-h-0`}>
            <div className="flex-shrink-0 p-8 pb-6">
              <div className="flex items-center gap-4">
                <div className="flex-shrink-0 relative">
                  <AgentAvatar
                    iconName={agent.icon_name}
                    iconColor={agent.icon_color}
                    backgroundColor={agent.icon_background}
                    agentName={agent.name}
                    size={56}
                  />
                  <div 
                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-30 h-10 blur-2xl opacity-100"
                    style={{
                      background: `radial-gradient(ellipse at center, ${agent.icon_color}, transparent)`
                    }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-2xl font-semibold text-foreground mb-2">
                    {agent.name}
                  </h1>
                </div>
              </div>
            </div>

            {agent.system_prompt && (
              <div className="flex-1 overflow-y-auto px-8 min-h-0 scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-muted-foreground/10">
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium text-muted-foreground">System Prompt</h3>
                  </div>
                  <div className="rounded-lg">
                    <Markdown className="text-xs [&>*]:text-xs [&>*]:opacity-50 [&>*]:leading-relaxed select-text">
                      {agent.system_prompt}
                    </Markdown>
                  </div>
                </div>
              </div>
            )}

            <div className="flex-shrink-0 bg-background p-6 space-y-6">
              {(integrations.length > 0 || customTools.length > 0 || triggerRequirements.length > 0) && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Plug className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium text-muted-foreground">Integrations</h3>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {integrations.map((integration, index) => (
                        <div
                          key={`int-${index}`}
                          className="flex items-center gap-2 p-2 rounded-lg border bg-card"
                        >
                          <IntegrationLogo
                            qualifiedName={integration.qualified_name}
                            displayName={integration.display_name || getAppDisplayName(integration.qualified_name)}
                            customType={integration.custom_type}
                            toolkitSlug={integration.toolkit_slug}
                            size="sm"
                          />
                          <span className="text-sm font-medium pr-2">
                            {integration.display_name || getAppDisplayName(integration.qualified_name)}
                          </span>
                        </div>
                      ))}
                      {triggerRequirements.map((trigger, index) => {
                        const appName = trigger.display_name?.split(' (')[0] || trigger.display_name;
                        const triggerName = trigger.display_name?.match(/\(([^)]+)\)/)?.[1] || trigger.display_name;
                        
                        return (
                          <div
                            key={`trig-${index}`}
                            className="flex items-center gap-2 p-2 rounded-lg border bg-card"
                          >
                            <IntegrationLogo
                              qualifiedName={trigger.qualified_name}
                              displayName={appName || getAppDisplayName(trigger.qualified_name)}
                              customType={trigger.custom_type || (trigger.qualified_name?.startsWith('composio.') ? 'composio' : undefined)}
                              toolkitSlug={trigger.toolkit_slug}
                              size="sm"
                            />
                            <div className="flex items-center gap-1">
                              <Zap className="h-3 w-3 text-muted-foreground" />
                              <span className="text-sm font-medium pr-2">
                                {triggerName || trigger.display_name}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                      {customTools.map((tool, index) => (
                        <div
                          key={`tool-${index}`}
                          className="flex items-center gap-2 p-2 rounded-lg border bg-card"
                        >
                          <IntegrationLogo
                            qualifiedName={tool.qualified_name}
                            displayName={tool.display_name || getAppDisplayName(tool.qualified_name)}
                            customType={tool.custom_type}
                            toolkitSlug={tool.toolkit_slug}
                            size="md"
                          />
                          <span className="text-sm font-medium pr-2">
                            {tool.display_name || getAppDisplayName(tool.qualified_name)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {agentpressTools.length === 0 && toolRequirements.length === 0 && triggerRequirements.length === 0 && (
                <div className="rounded-lg border bg-muted/20 p-6 text-center">
                  <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-muted-foreground">
                    This agent operates with core AI capabilities without external integrations
                  </p>
                </div>
              )}

              <Button
                onClick={handleInstall}
                disabled={isInstalling}
                className="w-full"
              >
                {isInstalling ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Download className="h-5 w-5" />
                    Install Agent
                  </>
                )}
              </Button>
            </div>
          </div>

          {hasUsageExamples && (
            <div className="w-1/2 flex flex-col p-4 overflow-hidden">
              <div className="px-0 py-4 flex-shrink-0">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium text-muted-foreground">Usage</h3>
                </div>
              </div>
              <div className="bg-white dark:bg-black p-3 rounded-xl flex-1 overflow-y-auto space-y-4 min-h-0">
                <div 
                  className="p-3 rounded-xl flex-1 overflow-y-auto space-y-4 h-full"
                  style={{
                    background: theme === 'dark' 
                      ? `linear-gradient(to bottom right, ${agent.icon_background}14, ${agent.icon_background}0A)`
                      : `linear-gradient(to bottom right, ${agent.icon_background}33, ${agent.icon_background}60)`
                  }}
                >
                  {(() => {
                    const messages = agent.usage_examples || [];
                    const groupedMessages: Array<{ role: string; messages: UsageExampleMessage[] }> = [];
                    
                    messages.forEach((message) => {
                      const lastGroup = groupedMessages[groupedMessages.length - 1];
                      if (lastGroup && lastGroup.role === message.role) {
                        lastGroup.messages.push(message);
                      } else {
                        groupedMessages.push({ role: message.role, messages: [message] });
                      }
                    });

                    return groupedMessages.map((group, groupIndex) => {
                      const isUser = group.role === 'user';
                      return (
                        <div key={groupIndex} className='flex'>
                          <div className={`group relative max-w-[85%]`}>
                            <div className="flex items-start gap-3">
                              {!isUser && (
                                <div className="flex-shrink-0 mt-1">
                                  <AgentAvatar
                                    iconName={agent.icon_name}
                                    iconColor={agent.icon_color}
                                    backgroundColor={agent.icon_background}
                                    agentName={agent.name}
                                    size={32}
                                  />
                                </div>
                              )}
                              {isUser && (
                                <div className="flex-shrink-0 mt-1">
                                  <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                                    <User className="h-4 w-4 text-muted" />
                                  </div>
                                </div>
                              )}
                              <div className='rounded-xl space-y-3'>
                                {group.messages.map((message, msgIndex) => (
                                  <div key={msgIndex}>
                                    <p className="text-sm mt-1 font-medium leading-relaxed whitespace-pre-wrap">{message.content}</p>
                                    {message.tool_calls && message.tool_calls.length > 0 && (
                                      <div className="mt-2 space-y-1.5">
                                        {message.tool_calls.map((tool, toolIndex) => (
                                          <div key={toolIndex} className="flex items-center gap-2 p-1 bg-white dark:bg-muted border rounded-md">
                                            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-muted-foreground/10 to-muted-foreground/5 border-2 flex items-center justify-center">
                                              <Wrench className="h-3 w-3" />
                                            </div>
                                            <span className="text-xs">{tool.name}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
                {!agent.usage_examples && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center space-y-3">
                      <MessageSquare className="h-12 w-12 text-muted-foreground/30 mx-auto" />
                      <p className="text-sm text-muted-foreground">No example conversations available</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
