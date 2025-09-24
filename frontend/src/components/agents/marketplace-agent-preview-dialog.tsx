'use client';

import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Bot, Download, Wrench, Plug, Tag, User, Calendar, Loader2, Share, Cpu, Eye, Zap } from 'lucide-react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { toast } from 'sonner';
import type { MarketplaceTemplate } from '@/components/agents/installation/types';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';
import { useRouter } from 'next/navigation';
import { backendApi } from '@/lib/api-client';
import { AgentIconAvatar } from '@/components/agents/config/agent-icon-avatar';

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
}> = ({ qualifiedName, displayName, customType, toolkitSlug }) => {
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

  return (
    <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 overflow-hidden rounded-sm">
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
      <div className={logoUrl ? "hidden" : "flex w-full h-full items-center justify-center bg-muted rounded-sm text-xs font-medium text-muted-foreground"}>
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

  console.log('agent', agent);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] p-0 overflow-hidden">
        <DialogHeader className='p-6'>
          <DialogTitle className='sr-only'>Agent Preview</DialogTitle>
          <div className="flex-shrink-0">
            <AgentIconAvatar
              profileImageUrl={agent.profile_image_url}
              iconName={agent.icon_name}
              iconColor={agent.icon_color}
              backgroundColor={agent.icon_background}
              agentName={agent.name}
              size={80}
              className="shadow-lg"
            />
          </div>
        </DialogHeader>
        <div className="-mt-4 flex flex-col max-h-[calc(90vh-8rem)] overflow-hidden">
          <div className="p-6 py-0 pb-4">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-foreground mb-2">
                  {agent.name}
                </h2>
                <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                  <div className="flex items-center gap-1">
                    <User className="h-4 w-4" />
                    {agent.creator_name || 'Unknown'}
                  </div>
                  <div className="flex items-center gap-1">
                    <Download className="h-4 w-4" />
                    {agent.download_count} downloads
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="h-4 w-4" />
                    {formatDate(agent.created_at)}
                  </div>
                </div>
              </div>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-4">
              {agent.description || 'No description available'}
            </p>
            {agent.tags && agent.tags.length > 0 && (
              <div className="flex items-center gap-2 mb-4">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <div className="flex flex-wrap gap-1">
                  {agent.tags.map((tag, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex-1 gap-4 overflow-y-auto p-6 pt-4 space-y-4">
            {agent.model && (
              <Card className='p-0 border-none bg-transparent shadow-none'>
                <CardContent className="p-0">
                  <div className="flex items-center gap-2 mb-3">
                    <Cpu className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Model Configuration</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant="secondary"
                      className="flex items-center px-3 py-1.5 bg-muted/50 hover:bg-muted border"
                    >
                      <span className="text-sm font-medium">
                        {agent.model.replace('openrouter/', '').replace('anthropic/', '')}
                      </span>
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            )}
            {integrations.length > 0 && (
              <Card className='p-0 border-none bg-transparent shadow-none'>
                <CardContent className="p-0">
                  <div className="flex items-center gap-2 mb-3">
                    <Plug className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Integrations</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {integrations.map((integration, index) => (
                      <Badge
                        key={index}
                        variant="secondary"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 hover:bg-muted border"
                      >
                        <IntegrationLogo
                          qualifiedName={integration.qualified_name}
                          displayName={integration.display_name || getAppDisplayName(integration.qualified_name)}
                          customType={integration.custom_type}
                          toolkitSlug={integration.toolkit_slug}
                        />
                        <span className="text-sm font-medium ml-1">
                          {integration.display_name || getAppDisplayName(integration.qualified_name)}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {triggerRequirements.length > 0 && (
              <Card className='p-0 border-none bg-transparent shadow-none'>
                <CardContent className="p-0">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Event Triggers</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {triggerRequirements.map((trigger, index) => {
                      const appName = trigger.display_name?.split(' (')[0] || trigger.display_name;
                      const triggerName = trigger.display_name?.match(/\(([^)]+)\)/)?.[1] || trigger.display_name;
                      
                      return (
                        <Badge
                          key={index}
                          variant="secondary"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 hover:bg-muted border"
                        >
                          <div className="flex items-center gap-1">
                            <IntegrationLogo
                              qualifiedName={trigger.qualified_name}
                              displayName={appName || getAppDisplayName(trigger.qualified_name)}
                              customType={trigger.custom_type || (trigger.qualified_name?.startsWith('composio.') ? 'composio' : undefined)}
                              toolkitSlug={trigger.toolkit_slug}
                            />
                            <span className="text-sm font-medium ml-1">
                              {triggerName || trigger.display_name}
                            </span>
                          </div>
                        </Badge>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
            {customTools.length > 0 && (
              <Card className='p-0 border-none bg-transparent shadow-none'>
                <CardContent className="p-0">
                  <div className="flex items-center gap-2 mb-3">
                    <Wrench className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Custom Tools</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {customTools.map((tool, index) => (
                      <Badge
                        key={index}
                        variant="secondary"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 hover:bg-muted border"
                      >
                        <IntegrationLogo
                          qualifiedName={tool.qualified_name}
                          displayName={tool.display_name || getAppDisplayName(tool.qualified_name)}
                          customType={tool.custom_type}
                          toolkitSlug={tool.toolkit_slug}
                        />
                        <span className="text-sm font-medium ml-1">
                          {tool.display_name || getAppDisplayName(tool.qualified_name)}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {agentpressTools.length === 0 && toolRequirements.length === 0 && triggerRequirements.length === 0 && (
              <Card>
                <CardContent className="p-4 text-center">
                  <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-muted-foreground">
                    This agent uses basic functionality without external integrations or specialized tools.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
          <div className="p-6 pt-4">
            <div className="flex gap-3">
              <Button
                onClick={handleInstall}
                disabled={isInstalling}
                className="flex-1"
              >
                {isInstalling ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Install Agent
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={handleShare} disabled={isGeneratingShareLink}>
                {isGeneratingShareLink ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Share className="h-4 w-4" />
                )}
                Share
              </Button>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
