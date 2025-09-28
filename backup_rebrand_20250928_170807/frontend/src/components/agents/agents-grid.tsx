import React, { useState } from 'react';
import { Settings, Trash2, Star, MessageCircle, Wrench, Globe, GlobeLock, Download, Shield, AlertTriangle, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import { useCreateTemplate, useUnpublishTemplate } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { toast } from 'sonner';
import { AgentCard } from './custom-agents-page/agent-card';
import { KortixLogo } from '../sidebar/kortix-logo';
import { DynamicIcon } from 'lucide-react/dynamic';
import { AgentConfigurationDialog } from './agent-configuration-dialog';
import { isStagingMode } from '@/lib/config';

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
  template_id?: string;
  current_version_id?: string;
  version_count?: number;
  current_version?: {
    version_id: string;
    version_name: string;
    version_number: number;
  };
  metadata?: {
    is_suna_default?: boolean;
    centrally_managed?: boolean;
    restrictions?: {
      system_prompt_editable?: boolean;
      tools_editable?: boolean;
      name_editable?: boolean;
      description_editable?: boolean;
      mcps_editable?: boolean;
    };
  };
  profile_image_url?: string;
  // Icon system fields
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
}

interface AgentsGridProps {
  agents: Agent[];
  onEditAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onToggleDefault: (agentId: string, currentDefault: boolean) => void;
  deleteAgentMutation?: { isPending: boolean }; // Made optional as we'll track per-agent state
  isDeletingAgent?: (agentId: string) => boolean;
  onPublish?: (agent: Agent) => void;
  publishingId?: string | null;
}

interface AgentModalProps {
  agent: Agent | null;
  isOpen: boolean;
  onClose: () => void;
  onCustomize: (agentId: string) => void;
  onChat: (agentId: string) => void;
  onPublish: (agentId: string) => void;
  onUnpublish: (agentId: string) => void;
  isPublishing: boolean;
  isUnpublishing: boolean;
}

const AgentModal: React.FC<AgentModalProps> = ({ 
  agent, 
  isOpen, 
  onClose, 
  onCustomize, 
  onChat, 
  onPublish, 
  onUnpublish, 
  isPublishing, 
  isUnpublishing 
}) => {
  if (!agent) return null;

  const isSunaAgent = agent.metadata?.is_suna_default || false;
  
  const truncateDescription = (text?: string, maxLength = 120) => {
    if (!text || text.length <= maxLength) return text || 'Try out this agent';
    return text.substring(0, maxLength) + '...';
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md p-0 overflow-hidden border-none">
        <DialogTitle className="sr-only">Agent actions</DialogTitle>
        <div className="relative">
          <div className={`p-4 h-24 flex items-start justify-start relative`}>
            {isSunaAgent ? (
              <div className="p-6">
                <KortixLogo size={48} />
              </div>
            ) : agent.icon_name ? (
              <div 
                className="h-16 w-16 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: agent.icon_background || '#F3F4F6' }}
              >
                <DynamicIcon 
                  name={agent.icon_name as any} 
                  size={32} 
                  color={agent.icon_color || '#000000'}
                />
              </div>
            ) : agent.profile_image_url ? (
              <img src={agent.profile_image_url} alt={agent.name} className="h-16 w-16 rounded-xl object-cover" />
            ) : (
              <div className="h-16 w-16 rounded-xl bg-muted flex items-center justify-center">
                <span className="text-lg font-semibold">{agent.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>

          <div className="p-4 space-y-2">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-xl font-semibold text-foreground">
                  {agent.name}
                </h2>
                {!isSunaAgent && agent.current_version && (
                  <Badge variant="outline" className="text-xs">
                    <GitBranch className="h-3 w-3" />
                    {agent.current_version.version_name}
                  </Badge>
                )}
                {agent.is_public && (
                  <Badge variant="outline" className="text-xs">
                    <Shield className="h-3 w-3 mr-1" />
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
            {!isSunaAgent && isStagingMode && (
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
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const AgentsGrid: React.FC<AgentsGridProps> = ({ 
  agents, 
  onEditAgent, 
  onDeleteAgent, 
  onToggleDefault,
  deleteAgentMutation,
  isDeletingAgent,
  onPublish,
  publishingId: externalPublishingId
}) => {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const router = useRouter();
  
  const unpublishAgentMutation = useUnpublishTemplate();

  const handleAgentClick = (agent: Agent) => {
    setSelectedAgent(agent);
  };

  const handleCustomize = (agentId: string) => {
    setSelectedAgent(null);
    setConfigAgentId(agentId);
    setShowConfigDialog(true);
  };

  const handleChat = (agentId: string) => {
    router.push(`/dashboard?agent_id=${agentId}`);
    setSelectedAgent(null);
  };

  const handlePublish = (agentId: string) => {
    const agent = agents.find(a => a.agent_id === agentId);
    if (agent && onPublish) {
      onPublish(agent);
      setSelectedAgent(null);
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


  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {agents.map((agent) => {
          const agentData = {
            ...agent,
            id: agent.agent_id
          };
          
          const isDeleting = isDeletingAgent?.(agent.agent_id) || false;
          const isGloballyDeleting = deleteAgentMutation?.isPending || false;
          
          return (
            <div key={agent.agent_id} className="relative group flex flex-col h-full">
              {isDeleting && (
                <div className="absolute inset-0 bg-destructive/10 backdrop-blur-sm rounded-lg z-20 flex items-center justify-center">
                  <div className="bg-background/95 backdrop-blur-sm rounded-lg px-4 py-3 flex items-center gap-2 shadow-lg border">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-destructive border-t-transparent" />
                    <span className="text-sm font-medium text-destructive">Deleting...</span>
                  </div>
                </div>
              )}
              
              <div className={`transition-all duration-200 ${isDeleting ? 'opacity-60 scale-95' : ''}`}>
                <AgentCard
                  mode="agent"
                  data={agentData}
                  styling={undefined}
                  onClick={() => !isDeleting && handleAgentClick(agent)}
                />
              </div>
              <div className={`absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity ${isDeleting ? 'pointer-events-none' : ''}`}>
                {!agent.is_default && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        className="h-7 w-7 p-0 hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                        disabled={isDeleting || isGloballyDeleting}
                        title="Delete agent"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isDeleting ? (
                          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-destructive border-t-transparent" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
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
                          disabled={isDeleting || isGloballyDeleting}
                          className="bg-destructive hover:bg-destructive/90 text-white"
                        >
                          {isDeleting ? (
                            <>
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent mr-2" />
                              Deleting...
                            </>
                          ) : (
                            'Delete'
                          )}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <AgentModal
        agent={selectedAgent}
        isOpen={!!selectedAgent}
        onClose={() => setSelectedAgent(null)}
        onCustomize={handleCustomize}
        onChat={handleChat}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        isPublishing={externalPublishingId === selectedAgent?.agent_id}
        isUnpublishing={unpublishingId === selectedAgent?.agent_id}
      />
      
      {configAgentId && (
        <AgentConfigurationDialog
          open={showConfigDialog}
          onOpenChange={setShowConfigDialog}
          agentId={configAgentId}
        />
      )}
    </>
  );
};