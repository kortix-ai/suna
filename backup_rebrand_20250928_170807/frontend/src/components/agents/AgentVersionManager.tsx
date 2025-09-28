'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  Clock, 
  GitBranch, 
  CheckCircle2, 
  ArrowUpRight,
  History,
  Plus
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAgentVersions, useActivateAgentVersion } from '@/lib/versioning';
import { Agent } from '@/hooks/react-query/agents/utils';
import { cn } from '@/lib/utils';
import { VersionInlineEditor } from './version-inline-editor';

interface AgentVersionManagerProps {
  agent: Agent;
  onCreateVersion?: () => void;
}

export function AgentVersionManager({ agent, onCreateVersion }: AgentVersionManagerProps) {
  const { data: versions, isLoading } = useAgentVersions(agent.agent_id);
  const activateVersion = useActivateAgentVersion();
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const currentVersion = versions?.find(v => v.isActive);
  const versionHistory = versions?.sort((a, b) => b.versionNumber.value - a.versionNumber.value) || [];

  const handleActivateVersion = (versionId: string) => {
    activateVersion.mutate({ 
      agentId: agent.agent_id, 
      versionId 
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              Version Management
            </CardTitle>
            <CardDescription>
              Manage different versions of your agent configuration
            </CardDescription>
          </div>
          {onCreateVersion && (
            <Button onClick={onCreateVersion} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              New Version
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="current" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="current">Current Version</TabsTrigger>
            <TabsTrigger value="history">Version History</TabsTrigger>
          </TabsList>
          
          <TabsContent value="current" className="space-y-4">
            {currentVersion ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant="default" className="text-sm">
                      {currentVersion.versionName}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Active version
                    </span>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                </div>
                
                <div className="grid gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Created</span>
                    <span>{formatDistanceToNow(currentVersion.createdAt, { addSuffix: true })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tools</span>
                    <span>{Object.keys(currentVersion.toolConfiguration.tools || {}).length} enabled</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">MCP Servers</span>
                    <span>{(currentVersion.configuredMcps?.length || 0) + (currentVersion.customMcps?.length || 0)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No version information available
              </div>
            )}
          </TabsContent>
          
          <TabsContent value="history" className="space-y-4">
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-3">
                {versionHistory.map((version, index) => {
                  const isActive = version.isActive;
                  const isSelected = version.versionId.value === selectedVersion;
                  
                  return (
                    <div
                      key={version.versionId.value}
                      className={cn(
                        "p-4 rounded-lg border cursor-pointer transition-colors",
                        isActive && "border-primary bg-primary/5",
                        !isActive && "hover:bg-muted/50",
                        isSelected && !isActive && "bg-muted"
                      )}
                      onClick={() => setSelectedVersion(version.versionId.value)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge variant={isActive ? "default" : "secondary"}>
                              {version.versionName}
                            </Badge>
                            {isActive && (
                              <Badge variant="outline" className="text-xs">
                                Current
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            Created {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                        
                        {!isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleActivateVersion(version.versionId.value);
                            }}
                            disabled={activateVersion.isPending}
                          >
                            <ArrowUpRight className="h-4 w-4 mr-1" />
                            Activate
                          </Button>
                        )}
                      </div>
                      
                      {isSelected && (
                        <div className="mt-3 pt-3 border-t space-y-2">
                          <div className="grid gap-1 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Tools</span>
                              <span>{Object.keys(version.agentpress_tools || {}).length} enabled</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">MCP Servers</span>
                              <span>{(version.configuredMcps?.length || 0) + (version.customMcps?.length || 0)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                
                {versionHistory.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <History className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No version history available</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
} 