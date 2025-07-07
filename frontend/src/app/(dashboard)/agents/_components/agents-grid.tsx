import React, { useState } from 'react';
import { Settings, Trash2, Star, MessageCircle, Wrench, Globe, GlobeLock, Download, Shield, AlertTriangle, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import { getAgentAvatar } from '../_utils/get-agent-style';
import { useCreateTemplate, useUnpublishTemplate } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { toast } from 'sonner';

interface Agent {
  agent_id: string;
  name: string;
  description?: string;
  is_default: boolean;
  is_public?: boolean;
  marketplace_published_at?: string;
  download_count?: number;
  tags?: string[];
  created_at: string;
  updated_at?: string;
  configured_mcps?: Array<{ name: string }>;
  agentpress_tools?: Record<string, any>;
  avatar?: string;
  avatar_color?: string;
  template_id?: string;
  current_version_id?: string;
  version_count?: number;
  current_version?: {
    version_id: string;
    version_name: string;
    version_number: number;
  };
}

interface AgentsGridProps {
  agents: Agent[];
  onEditAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onToggleDefault: (agentId: string, currentDefault: boolean) => void;
  deleteAgentMutation: { isPending: boolean };
}

const AgentModal = ({ agent, isOpen, onClose, onCustomize, onChat, onPublish, onUnpublish, isPublishing, isUnpublishing }) => {
  const getAgentStyling = (agent: Agent) => {
    if (agent.avatar && agent.avatar_color) {
      return {
        avatar: agent.avatar,
        color: agent.avatar_color,
      };
    }
    return getAgentAvatar(agent.agent_id);
  };

  const { avatar, color } = getAgentStyling(agent);
  
  const truncateDescription = (text, maxLength = 120) => {
    if (!text || text.length <= maxLength) return text || 'Try out this agent';
    return text.substring(0, maxLength) + '...';
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md p-0 overflow-hidden border-none">
        <DialogTitle className="sr-only">Agent actions</DialogTitle>
        <div className="relative">
          <div className={`h-32 flex items-center justify-center relative bg-gradient-to-br from-opacity-90 to-opacity-100`} style={{ backgroundColor: color }}>
            <div className="text-6xl drop-shadow-sm">
              {avatar}
            </div>
            <div className="absolute top-4 right-4 flex gap-2">
              {agent.is_default && (
                <Star className="h-5 w-5 text-white fill-white drop-shadow-sm" />
              )}
            </div>
          </div>

          <div className="p-4 space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-xl font-semibold text-foreground">
                  {agent.name}
                </h2>
                {agent.current_version && (
                  <Badge variant="outline" className="text-xs">
                    <GitBranch className="h-3 w-3" />
                    {agent.current_version.version_name}
                  </Badge>
                )}
                {agent.is_public && (
                  <Badge variant="outline" className="text-xs">
                    <Shield className="h-3 w-3" />
                    Published
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {truncateDescription(agent.description)}
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                onClick={() => onCustomize(agent.agent_id)}
                variant="outline"
                className="flex-1 gap-2"
              >
                <Wrench className="h-4 w-4" />
                Customize
              </Button>
              <Button
                onClick={() => onChat(agent.agent_id)}
                className="flex-1 gap-2 bg-primary hover:bg-primary/90"
              >
                <MessageCircle className="h-4 w-4" />
                Chat
              </Button>
            </div>
            <div className="pt-2">
              {agent.is_public ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Published as secure template</span>
                    <div className="flex items-center gap-1">
                      <Download className="h-3 w-3" />
                      {agent.download_count || 0} downloads
                    </div>
                  </div>
                  <Button
                    onClick={() => onUnpublish(agent.agent_id)}
                    disabled={isUnpublishing}
                    variant="outline"
                    className="w-full gap-2"
                  >
                    {isUnpublishing ? (
                      <>
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        Making Private...
                      </>
                    ) : (
                      <>
                        <GlobeLock className="h-4 w-4" />
                        Make Private
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => onPublish(agent.agent_id)}
                  disabled={isPublishing}
                  variant="outline"
                  className="w-full gap-2"
                >
                  {isPublishing ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      Publishing...
                    </>
                  ) : (
                    <>
                      <Shield className="h-4 w-4" />
                      Publish as Template
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const AgentsGrid = ({ 
  agents, 
  onEditAgent, 
  onDeleteAgent, 
  onToggleDefault,
  deleteAgentMutation 
}: AgentsGridProps) => {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const router = useRouter();
  
  const unpublishAgentMutation = useUnpublishTemplate();
  const createTemplateMutation = useCreateTemplate();

  const handleAgentClick = (agent: Agent) => {
    setSelectedAgent(agent);
  };

  const handleCustomize = (agentId: string) => {
    router.push(`/agents/new/${agentId}`);
    setSelectedAgent(null);
  };

  const handleChat = (agentId: string) => {
    router.push(`/dashboard?agent_id=${agentId}`);
    setSelectedAgent(null);
  };

  const handlePublish = async (agentId: string) => {
    try {
      setPublishingId(agentId);
      const result = await createTemplateMutation.mutateAsync({ 
        agent_id: agentId, 
        make_public: true,
        tags: [] 
      });
      toast.success('Agent published!');
      setSelectedAgent(null);
    } catch (error: any) {
      toast.error('Failed to create secure template');
    } finally {
      setPublishingId(null);
    }
  };

  const handleUnpublish = async (agentId: string) => {
    try {
      setUnpublishingId(agentId);
      await unpublishAgentMutation.mutateAsync(agentId);
      toast.success('Agent made private');
      setSelectedAgent(null);
    } catch (error: any) {
      toast.error('Failed to make agent private');
    } finally {
      setUnpublishingId(null);
    }
  };

  const getAgentStyling = (agent: Agent) => {
    if (agent.avatar && agent.avatar_color) {
      return {
        avatar: agent.avatar,
        color: agent.avatar_color,
      };
    }
    return getAgentAvatar(agent.agent_id);
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {agents.map((agent) => {
          const { avatar, color } = getAgentStyling(agent);
          const isPublishing = publishingId === agent.agent_id;
          const isUnpublishing = unpublishingId === agent.agent_id;
          return (
            <div 
              key={agent.agent_id} 
              className="bg-neutral-100 dark:bg-sidebar border border-border rounded-2xl overflow-hidden hover:bg-muted/50 transition-all duration-200 cursor-pointer group"
              onClick={() => handleAgentClick(agent)}
            >
              <div className='p-4'>
                <div className={`h-12 w-12 flex items-center justify-center rounded-lg`} style={{ backgroundColor: color }}>
                  <div className="text-2xl">
                    {avatar}
                  </div>
                </div>
              </div>
              <div className="p-4 -mt-4 flex flex-col flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-foreground font-medium text-lg line-clamp-1 flex-1">
                    {agent.name}
                  </h3>
                  {agent.current_version && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      <GitBranch className="h-3 w-3" />
                      {agent.current_version.version_name}
                    </Badge>
                  )}
                  {agent.is_public && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      <Shield className="h-3 w-3" />
                      Published
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-sm mb-4 line-clamp-2">
                  {agent.description || 'Try out this agent'}
                </p>
                
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">
                    By me
                  </span>
                  
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!agent.is_default && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            className="h-7 w-7 p-0 hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                            disabled={deleteAgentMutation.isPending}
                            title="Delete agent"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="max-w-md">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-xl">Delete Agent</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete &quot;{agent.name}&quot;? This action cannot be undone.
                              {agent.is_public && (
                                <span className="block mt-2 text-amber-600 dark:text-amber-400">
                                  Note: This agent is currently published to the marketplace and will be removed from there as well.
                                </span>
                              )}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteAgent(agent.agent_id);
                              }}
                              disabled={deleteAgentMutation.isPending}
                              className="bg-destructive hover:bg-destructive/90 text-white"
                            >
                              {deleteAgentMutation.isPending ? 'Deleting...' : 'Delete'}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {selectedAgent && (
        <AgentModal
          agent={selectedAgent}
          isOpen={!!selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onCustomize={handleCustomize}
          onChat={handleChat}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          isPublishing={publishingId === selectedAgent.agent_id}
          isUnpublishing={unpublishingId === selectedAgent.agent_id}
        />
      )}
    </>
  );
};