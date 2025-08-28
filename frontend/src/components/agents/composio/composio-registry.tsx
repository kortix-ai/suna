import React, { useState, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Zap, X, Settings, ChevronDown, ChevronUp, Loader2, Server } from 'lucide-react';
import { useComposioCategories, useComposioToolkitsInfinite } from '@/hooks/react-query/composio/use-composio';
import { useComposioProfiles } from '@/hooks/react-query/composio/use-composio-profiles';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { useUpdateAgentMCPs } from '@/hooks/react-query/agents/use-update-agent-mcps';
import { ComposioConnector } from './composio-connector';
import { ComposioToolsManager } from './composio-tools-manager';
import type { ComposioToolkit, ComposioProfile } from '@/hooks/react-query/composio/utils';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CustomMCPDialog } from '../mcp/custom-mcp-dialog';

const CATEGORY_EMOJIS: Record<string, string> = {
  'popular': '🔥',
  'productivity': '📊',
  'crm': '👥',
  'marketing': '📢',
  'analytics': '📈',
  'communication': '💬',
  'project-management': '📋',
  'scheduling': '📅',
};

interface ConnectedApp {
  toolkit: ComposioToolkit;
  profile: ComposioProfile;
  mcpConfig: {
    name: string;
    type: string;
    config: Record<string, any>;
    enabledTools: string[];
  };
}

interface ComposioRegistryProps {
  onToolsSelected?: (profileId: string, selectedTools: string[], appName: string, appSlug: string) => void;
  onAppSelected?: (app: ComposioToolkit) => void;
  mode?: 'full' | 'profile-only';
  onClose?: () => void;
  showAgentSelector?: boolean;
  selectedAgentId?: string;
  onAgentChange?: (agentId: string | undefined) => void;
}

const getAgentConnectedApps = (
  agent: any,
  profiles: ComposioProfile[],
  toolkits: ComposioToolkit[]
): ConnectedApp[] => {
  if (!agent?.custom_mcps || !profiles?.length || !toolkits?.length) return [];

  const connectedApps: ConnectedApp[] = [];
  
  agent.custom_mcps.forEach((mcpConfig: any) => {
    if (mcpConfig.config?.profile_id) {
      const profile = profiles.find(p => p.profile_id === mcpConfig.config.profile_id);
      const toolkit = toolkits.find(t => t.slug === profile?.toolkit_slug);
      if (profile && toolkit) {
        connectedApps.push({
          toolkit,
          profile,
          mcpConfig
        });
      }
    }
  });

  return connectedApps;
};

const isAppConnectedToAgent = (
  agent: any,
  appSlug: string,
  profiles: ComposioProfile[]
): boolean => {
  if (!agent?.custom_mcps) return false;

  return agent.custom_mcps.some((mcpConfig: any) => {
    if (mcpConfig.config?.profile_id) {
      const profile = profiles.find(p => p.profile_id === mcpConfig.config.profile_id);
      return profile?.toolkit_slug === appSlug;
    }
    return false;
  });
};

const AppCardSkeleton = () => (
  <div className="border border-border/50 rounded-xl p-4">
    <div className="flex items-center gap-3 mb-3">
      <Skeleton className="w-10 h-10 rounded-lg" />
      <div className="flex-1">
        <Skeleton className="w-3/4 h-4 mb-2" />
        <Skeleton className="w-full h-3" />
      </div>
    </div>
    <div className="flex flex-wrap gap-1 mb-3">
      <Skeleton className="w-16 h-5" />
      <Skeleton className="w-20 h-5" />
    </div>
    <div className="flex justify-between items-center">
      <Skeleton className="w-24 h-6" />
      <Skeleton className="w-20 h-8" />
    </div>
  </div>
);

const ConnectedAppSkeleton = () => (
  <div className="border border-border/50 rounded-2xl p-4">
    <div className="flex items-start gap-3 mb-3">
      <Skeleton className="w-10 h-10 rounded-lg" />
      <div className="flex-1">
        <Skeleton className="w-3/4 h-4 mb-2" />
        <Skeleton className="w-full h-3" />
      </div>
      <Skeleton className="w-8 h-8 rounded" />
    </div>
    <div className="flex justify-between items-center">
      <Skeleton className="w-32 h-4" />
    </div>
  </div>
);

const ConnectedAppCard = ({ 
  connectedApp, 
  onToggleTools, 
  onConfigure,
  onManageTools,
  isUpdating 
}: {
  connectedApp: ConnectedApp;
  onToggleTools: (profileId: string, enabled: boolean) => void;
  onConfigure: (app: ComposioToolkit, profile: ComposioProfile) => void;
  onManageTools: (connectedApp: ConnectedApp) => void;
  isUpdating: boolean;
}) => {
  const { toolkit, profile, mcpConfig } = connectedApp;
  const hasEnabledTools = mcpConfig.enabledTools && mcpConfig.enabledTools.length > 0;

  return (
    <div 
      className="group border bg-card rounded-2xl p-4 transition-all duration-200 cursor-pointer"
    >
      <div className="flex items-start gap-3 mb-3">
        {toolkit.logo ? (
          <img src={toolkit.logo} alt={toolkit.name} className="w-10 h-10 rounded-lg object-cover p-2 bg-muted rounded-xl border" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="text-primary text-sm font-medium">{toolkit.name.charAt(0)}</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm leading-tight truncate mb-1">{toolkit.name}</h3>
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            Connected as "{profile.profile_name}"
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onManageTools(connectedApp)}
            disabled={isUpdating}
            type="button"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            {hasEnabledTools ? `${mcpConfig.enabledTools.length} tools enabled` : 'Connected (no tools)'}
          </div>
        </div>
      </div>
    </div>
  );
};

const AppCard = ({ app, profiles, onConnect, onConfigure, isConnectedToAgent, currentAgentId, mode }: {
  app: ComposioToolkit; 
  profiles: ComposioProfile[];
  onConnect: () => void;
  onConfigure: (profile: ComposioProfile) => void;
  isConnectedToAgent: boolean;
  currentAgentId?: string;
  mode?: 'full' | 'profile-only';
}) => {
  const connectedProfiles = profiles.filter(p => p.is_connected);
  const canConnect = mode === 'profile-only' ? true : (!isConnectedToAgent && currentAgentId);
  
  return (
    <div 
      onClick={canConnect ? (connectedProfiles.length > 0 ? () => onConfigure(connectedProfiles[0]) : onConnect) : undefined}
      className={cn(
        "group border bg-card rounded-2xl p-4 transition-all duration-200",
        canConnect ? "hover:bg-muted cursor-pointer" : "opacity-60 cursor-not-allowed"
      )}
    >
      <div className="flex items-start gap-3 mb-3">
        {app.logo ? (
          <img src={app.logo} alt={app.name} className="w-10 h-10 rounded-lg object-cover p-2 bg-muted rounded-xl border" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="text-primary text-sm font-medium">{app.name.charAt(0)}</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm leading-tight truncate mb-1">{app.name}</h3>
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {app.description || `Connect your ${app.name} account to access its features.`}
          </p>
        </div>
      </div>
      
      {app.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {app.tags.slice(0, 2).map((tag, index) => (
            <Badge key={index} variant="secondary" className="text-xs px-1.5 py-0.5 h-auto">
              {tag}
            </Badge>
          ))}
          {app.tags.length > 2 && (
            <Badge variant="outline" className="text-xs px-1.5 py-0.5 h-auto">
              +{app.tags.length - 2}
            </Badge>
          )}
        </div>
      )}
      
      <div className="flex justify-between items-center">
        {mode === 'profile-only' ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
              {connectedProfiles.length > 0 ? `${connectedProfiles.length} existing profile${connectedProfiles.length !== 1 ? 's' : ''}` : 'Click to connect'}
            </div>
          </div>
        ) : isConnectedToAgent ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              Connected to this agent
            </div>
          </div>
        ) : connectedProfiles.length > 0 ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Profile available ({connectedProfiles.length})
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
              Not connected
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const ComposioRegistry: React.FC<ComposioRegistryProps> = ({
  onToolsSelected,
  onAppSelected,
  mode = 'full',
  onClose,
  showAgentSelector = false,
  selectedAgentId,
  onAgentChange,
}) => {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedApp, setSelectedApp] = useState<ComposioToolkit | null>(null);
  const [showConnector, setShowConnector] = useState(false);
  const [showConnectedApps, setShowConnectedApps] = useState(true);
  const [showToolsManager, setShowToolsManager] = useState(false);
  const [selectedConnectedApp, setSelectedConnectedApp] = useState<ConnectedApp | null>(null);
  const [showCustomMCPDialog, setShowCustomMCPDialog] = useState(false);
  
  const [internalSelectedAgentId, setInternalSelectedAgentId] = useState<string | undefined>(selectedAgentId);
  const queryClient = useQueryClient();
  
  const { data: categoriesData, isLoading: isLoadingCategories } = useComposioCategories();
  const {
    data: toolkitsInfiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError
  } = useComposioToolkitsInfinite(search, selectedCategory);
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  
  const allToolkits = useMemo(() => {
    if (!toolkitsInfiniteData?.pages) return [];
    return toolkitsInfiniteData.pages.flatMap(page => page.toolkits || []);
  }, [toolkitsInfiniteData]);

  const currentAgentId = selectedAgentId ?? internalSelectedAgentId;
  const { data: agent, isLoading: isLoadingAgent } = useAgent(currentAgentId || '');
  const { mutate: updateAgent, isPending: isUpdatingAgent } = useUpdateAgentMCPs(); // Use the MCP-specific hook

  const handleAgentSelect = (agentId: string | undefined) => {
    if (onAgentChange) {
      onAgentChange(agentId);
    } else {
      setInternalSelectedAgentId(agentId);
    }
  };

  const profilesByToolkit = useMemo(() => {
    const grouped: Record<string, ComposioProfile[]> = {};
    profiles?.forEach(profile => {
      if (profile.is_connected) {
        if (!grouped[profile.toolkit_slug]) {
          grouped[profile.toolkit_slug] = [];
        }
        grouped[profile.toolkit_slug].push(profile);
      }
    });
    return grouped;
  }, [profiles]);

  const connectedApps = useMemo(() => {
    if (!currentAgentId || !agent) return [];
    return getAgentConnectedApps(agent, profiles || [], allToolkits);
  }, [agent, profiles, allToolkits, currentAgentId]);

  const isLoadingConnectedApps = currentAgentId && (isLoadingAgent || isLoadingProfiles || isLoading);

  const filteredToolkits = useMemo(() => {
    if (!allToolkits) return [];
    return allToolkits;
  }, [allToolkits]);

  const handleConnect = (app: ComposioToolkit) => {
    if (mode !== 'profile-only' && !currentAgentId && showAgentSelector) {
      toast.error('Please select an agent first');
      return;
    }
    setSelectedApp(app);
    setShowConnector(true);
  };

  const handleConfigure = (app: ComposioToolkit, profile: ComposioProfile) => {
    if (mode !== 'profile-only' && !currentAgentId) {
      toast.error('Please select an agent first');
      return;
    }
    setSelectedApp(app);
    setShowConnector(true);
  };

    const handleToggleTools = (profileId: string, enabled: boolean) => {
    if (!currentAgentId || !agent) return;

    const updatedCustomMcps = agent.custom_mcps?.map((mcpConfig: any) => {
      if (mcpConfig.config?.profile_id === profileId) {
        return {
          ...mcpConfig,
          enabledTools: enabled ? mcpConfig.enabledTools || [] : []
        };
      }
      return mcpConfig;
    }) || [];

    updateAgent({
      agentId: currentAgentId,
      custom_mcps: updatedCustomMcps
    }, {
      onSuccess: () => {
        toast.success(enabled ? 'Tools enabled' : 'Tools disabled');
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to update tools');
      }
    });
  };

  const handleManageTools = (connectedApp: ConnectedApp) => {
    setSelectedConnectedApp(connectedApp);
    setShowToolsManager(true);
  };

  const handleConnectionComplete = (profileId: string, appName: string, appSlug: string) => {
    setShowConnector(false);
    queryClient.invalidateQueries({ queryKey: ['composio', 'profiles'] });
    
    if (currentAgentId) {
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', currentAgentId] });
    }
    
    if (onToolsSelected) {
      onToolsSelected(profileId, [], appName, appSlug);
    }
  };

  const handleCustomMCPSave = async (customConfig: any): Promise<void> => {
    if (!currentAgentId) {
      throw new Error('Please select an agent first');
    }

    // Create MCP configuration for agent
    const mcpConfig = {
      name: customConfig.name || 'Custom MCP',
      type: customConfig.type || 'sse',
      config: customConfig.config || {},
      enabledTools: customConfig.enabledTools || [],
    };

    // Get current custom MCPs from agent
    const currentCustomMcps = agent?.custom_mcps || [];
    const updatedCustomMcps = [...currentCustomMcps, mcpConfig];

    // Return a promise that resolves/rejects based on the mutation result
    return new Promise((resolve, reject) => {
      updateAgent({
        agentId: currentAgentId,
        custom_mcps: updatedCustomMcps,
        replace_mcps: true  // Use replace mode to ensure proper updates
      }, {
        onSuccess: () => {
          toast.success(`Custom MCP "${customConfig.name}" added successfully`);
          queryClient.invalidateQueries({ queryKey: ['agents', 'detail', currentAgentId] });
          resolve();
        },
        onError: (error: any) => {
          reject(new Error(error.message || 'Failed to add custom MCP'));
        }
      });
    });
  };

  const categories = categoriesData?.categories || [];

  return (
    <div className="h-full w-full overflow-hidden flex">
      {/*<div className="w-64 h-full overflow-hidden border-r bg-muted/20">
        <div className="h-full flex flex-col">
          <div className="flex-shrink-0 p-4 border-b">
            <h3 className="text-sm font-medium text-muted-foreground">Categories</h3>
          </div>
          
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4 space-y-1">
                <button
                  onClick={() => setSelectedCategory('')}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors text-left",
                    selectedCategory === '' 
                      ? "bg-muted-foreground/20 text-muted-foreground" 
                      : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="text-base">📁</span>
                  <span>All Apps</span>
                </button>

                {isLoadingCategories ? (
                  <div className="space-y-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2">
                        <Skeleton className="w-4 h-4 bg-muted rounded" />
                        <Skeleton className="flex-1 h-4 bg-muted rounded" />
                      </div>
                    ))}
                  </div>
                ) : (
                  categories.map((category) => (
                    <button
                      key={category.id}
                      onClick={() => setSelectedCategory(category.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors text-left",
                        selectedCategory === category.id 
                          ? "bg-muted-foreground/20 text-muted-foreground" 
                          : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <span className="text-base">{CATEGORY_EMOJIS[category.id] || '📁'}</span>
                      <span className="truncate">{category.name}</span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>*/}
      <div className="flex-1 h-full overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="flex-shrink-0 border-b p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1 min-w-0 pr-4">
                <h2 className="text-xl font-semibold">
                  {mode === 'profile-only' ? 'Connect New App' : 'App Integrations'}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {mode === 'profile-only' 
                    ? 'Create a connection profile for your favorite apps'
                    : `Connect your favorite apps with ${currentAgentId ? 'this agent' : 'your agent'}`
                  }
                </p>
              </div>
              <div className="flex-shrink-0">
                <div className="flex items-center gap-3">
                  {/* {showAgentSelector && (
                    <AgentSelector
                      selectedAgentId={currentAgentId}
                      onAgentSelect={handleAgentSelect}
                      isSunaAgent={agent?.metadata?.is_suna_default}
                    />
                  )} */}
                </div>
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search apps..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>
                {mode !== 'profile-only' && currentAgentId && (
                  <Button 
                    variant="outline" 
                    onClick={() => setShowCustomMCPDialog(true)}
                    className="flex items-center gap-2 whitespace-nowrap h-10"
                  >
                    <Server className="h-4 w-4" />
                    Add Custom MCP
                  </Button>
                )}
              </div>

              {selectedCategory && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Filtered by:</span>
                  <Badge variant="outline" className="gap-1 bg-muted-foreground/20 text-muted-foreground">
                    <span>{CATEGORY_EMOJIS[selectedCategory] || '📁'}</span>
                    <span>{categories.find(c => c.id === selectedCategory)?.name}</span>
                    <button
                      onClick={() => setSelectedCategory('')}
                      className="ml-1 hover:bg-muted rounded-full p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 space-y-6">
                {currentAgentId && (
                  <Collapsible open={showConnectedApps} onOpenChange={setShowConnectedApps}>
                    <CollapsibleTrigger asChild>
                      <div className="w-full hover:underline flex items-center justify-between p-0 h-auto">
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-medium">Connected to this agent</h3>
                          {isLoadingConnectedApps ? (
                            <Skeleton className="w-6 h-5 rounded ml-2" />
                          ) : connectedApps.length > 0 && (
                            <Badge variant="outline" className="ml-2">
                              {connectedApps.length}
                            </Badge>
                          )}
                        </div>
                        {showConnectedApps ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-4">
                      {isLoadingConnectedApps ? (
                        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                          {Array.from({ length: 3 }).map((_, i) => (
                            <ConnectedAppSkeleton key={i} />
                          ))}
                        </div>
                      ) : connectedApps.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4 mx-auto">
                            <Zap className="h-8 w-8 text-muted-foreground" />
                          </div>
                          <h4 className="text-sm font-medium mb-2">No connected apps</h4>
                          <p className="text-xs">Connect apps below to manage tools for this agent.</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-4 gap-4">
                          {connectedApps.map((connectedApp) => (
                            <ConnectedAppCard
                              key={connectedApp.profile.profile_id}
                              connectedApp={connectedApp}
                              onToggleTools={handleToggleTools}
                              onConfigure={handleConfigure}
                              onManageTools={handleManageTools}
                              isUpdating={isUpdatingAgent}
                            />
                          ))}
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
                <div>
                  <h3 className="text-lg font-medium mb-4">
                    {currentAgentId ? 'Available Apps' : 'Browse Apps'}
                  </h3>
                  
                  {isLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {Array.from({ length: 12 }).map((_, i) => (
                        <AppCardSkeleton key={i} />
                      ))}
                    </div>
                  ) : filteredToolkits.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                        <Search className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <h3 className="text-lg font-medium mb-2">No apps found</h3>
                      <p className="text-muted-foreground">
                        {search ? `No apps match "${search}"` : 'No apps available in this category'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {filteredToolkits.map((app) => (
                          <AppCard
                            key={app.slug}
                            app={app}
                            profiles={profilesByToolkit[app.slug] || []}
                            onConnect={() => handleConnect(app)}
                            onConfigure={(profile) => handleConfigure(app, profile)}
                            isConnectedToAgent={isAppConnectedToAgent(agent, app.slug, profiles || [])}
                            currentAgentId={currentAgentId}
                            mode={mode}
                          />
                        ))}
                      </div>
                      {hasNextPage && (
                        <div className="flex justify-center pt-4">
                          <Button
                            variant="outline"
                            onClick={() => fetchNextPage()}
                            disabled={isFetchingNextPage}

                          >
                            {isFetchingNextPage ? (
                              <>
                                <Loader2 className="animate-spin h-4 w-4 " />
                                Loading more...
                              </>
                            ) : (
                              'Load More Apps'
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
      {selectedApp && (
        <ComposioConnector
          app={selectedApp}
          agentId={currentAgentId}
          open={showConnector}
          onOpenChange={setShowConnector}
          onComplete={handleConnectionComplete}
          mode={mode}
        />
      )}

      {selectedConnectedApp && currentAgentId && (
        <ComposioToolsManager
          agentId={currentAgentId}
          open={showToolsManager}
          onOpenChange={setShowToolsManager}
          profileId={selectedConnectedApp.profile.profile_id}
          profileInfo={{
            profile_id: selectedConnectedApp.profile.profile_id,
            profile_name: selectedConnectedApp.profile.profile_name,
            toolkit_name: selectedConnectedApp.toolkit.name,
            toolkit_slug: selectedConnectedApp.toolkit.slug,
          }}
          appLogo={selectedConnectedApp.toolkit.logo}
          onToolsUpdate={() => {
            queryClient.invalidateQueries({ queryKey: ['agents', 'detail', currentAgentId] });
          }}
        />
      )}
      <CustomMCPDialog
        open={showCustomMCPDialog}
        onOpenChange={setShowCustomMCPDialog}
        onSave={handleCustomMCPSave}
      />
    </div>
  );
}; 