import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Zap, Server, Store, Settings } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MCPConfigurationProps, MCPConfiguration as MCPConfigurationType } from './types';
import { ConfiguredMcpList } from './configured-mcp-list';
import { CustomMCPDialog } from './custom-mcp-dialog';
import { ComposioRegistry } from '../composio/composio-registry';
import { ComposioToolsManager } from '../composio/composio-tools-manager';
import { ToolsManager } from './tools-manager';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

export const MCPConfigurationNew: React.FC<MCPConfigurationProps> = ({
  configuredMCPs,
  onConfigurationChange,
  agentId,
  versionData,
  saveMode = 'direct',
  versionId,
  isLoading = false
}) => {
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [showRegistryDialog, setShowRegistryDialog] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [showComposioToolsManager, setShowComposioToolsManager] = useState(false);
  const [showCustomToolsManager, setShowCustomToolsManager] = useState(false);
  const [selectedMCPForTools, setSelectedMCPForTools] = useState<MCPConfigurationType | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(agentId);
  const queryClient = useQueryClient();

  const handleAgentChange = (newAgentId: string | undefined) => {
    setSelectedAgentId(newAgentId);
  };

  const handleEditMCP = (index: number) => {
    const mcp = configuredMCPs[index];
    if (mcp.customType === 'composio') {
      setEditingIndex(index);
      setShowCustomDialog(true);
    } else {
      setEditingIndex(index);
      setShowCustomDialog(true);
    }
  };

  const handleConfigureTools = (index: number) => {
    const mcp = configuredMCPs[index];
    setSelectedMCPForTools(mcp);
    if (mcp.customType === 'composio') {
      const profileId = mcp.selectedProfileId || mcp.config?.profile_id;
      if (profileId) {
        setShowComposioToolsManager(true);
      } else {
        console.warn('Composio MCP has no profile_id:', mcp);
      }
    } else {
      setShowCustomToolsManager(true);
    }
  };

  const handleRemoveMCP = (index: number) => {
    const newMCPs = configuredMCPs.filter((_, i) => i !== index);
    onConfigurationChange(newMCPs);
  };

  const handleSaveCustomMCP = (customConfig: any) => {
    const mcpConfig: MCPConfigurationType = {
      name: customConfig.name,
      qualifiedName: `custom_${customConfig.type}_${Date.now()}`,
      config: customConfig.config,
      enabledTools: customConfig.enabledTools,
      selectedProfileId: customConfig.selectedProfileId,
      isCustom: true,
      customType: customConfig.type as 'http' | 'sse'
    };
    onConfigurationChange([...configuredMCPs, mcpConfig]);
  };

  const handleToolsSelected = (profileId: string, selectedTools: string[], appName: string, appSlug: string) => {
    setShowRegistryDialog(false);
    if (selectedAgentId) {
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', selectedAgentId] });
    }
    queryClient.invalidateQueries({ queryKey: ['composio', 'profiles'] });
    toast.success(`Connected ${appName} integration!`);
  };

  const handleCustomToolsUpdate = (enabledTools: string[]) => {
    if (!selectedMCPForTools) return;
    
    const updatedMCPs = configuredMCPs.map(mcp => 
      mcp === selectedMCPForTools 
        ? { ...mcp, enabledTools }
        : mcp
    );
    onConfigurationChange(updatedMCPs);
    setShowCustomToolsManager(false);
    setSelectedMCPForTools(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button onClick={() => setShowRegistryDialog(true)} size="sm" variant="default" className="gap-2" type="button">
            <Store className="h-4 w-4" />
            Browse Apps
          </Button>
          <Button onClick={() => setShowCustomDialog(true)} size="sm" variant="outline" className="gap-2" type="button">
            <Server className="h-4 w-4" />
            Custom MCP
          </Button>
        </div>
      </div>
      
      {configuredMCPs.length === 0 && (
        <div className="text-center py-12 px-6 bg-muted/30 rounded-xl border-2 border-dashed border-border">
          <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
            <Server className="h-6 w-6 text-muted-foreground" />
          </div>
          <h4 className="text-sm font-semibold text-foreground mb-2">
            No integrations configured
          </h4>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
            Browse the app registry to connect your apps or add custom MCP servers
          </p>
        </div>
      )}
      
      {configuredMCPs.length > 0 && (
        <div className="space-y-4">
          <ConfiguredMcpList
            configuredMCPs={configuredMCPs}
            onEdit={handleEditMCP}
            onRemove={handleRemoveMCP}
            onConfigureTools={handleConfigureTools}
          />
        </div>
      )}
      
      <Dialog open={showRegistryDialog} onOpenChange={setShowRegistryDialog}>
        <DialogContent className="p-0 max-w-6xl h-[90vh] overflow-hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Select Integration</DialogTitle>
          </DialogHeader>
          <ComposioRegistry 
            showAgentSelector={false} 
            selectedAgentId={selectedAgentId} 
            onAgentChange={handleAgentChange} 
            onToolsSelected={handleToolsSelected}
            onClose={() => {
              setShowRegistryDialog(false);
              if (selectedAgentId) {
                queryClient.invalidateQueries({ queryKey: ['agents', 'detail', selectedAgentId] });
              }
            }}
          />
        </DialogContent>
      </Dialog>
      <CustomMCPDialog
        open={showCustomDialog}
        onOpenChange={setShowCustomDialog}
        onSave={handleSaveCustomMCP}
      />
      {selectedMCPForTools && selectedMCPForTools.customType === 'composio' && (selectedMCPForTools.selectedProfileId || selectedMCPForTools.config?.profile_id) && (
        <ComposioToolsManager
          agentId={selectedAgentId || ''}
          open={showComposioToolsManager}
          onOpenChange={setShowComposioToolsManager}
          profileId={selectedMCPForTools.selectedProfileId || selectedMCPForTools.config?.profile_id}
          onToolsUpdate={() => {
            setShowComposioToolsManager(false);
            setSelectedMCPForTools(null);
          }}
        />
      )}
      {selectedMCPForTools && selectedMCPForTools.customType !== 'composio' && (
        <ToolsManager
          mode="custom"
          agentId={selectedAgentId}
          mcpConfig={{
            ...selectedMCPForTools.config,
            type: selectedMCPForTools.customType
          }}
          mcpName={selectedMCPForTools.name}
          open={showCustomToolsManager}
          onOpenChange={setShowCustomToolsManager}
          onToolsUpdate={handleCustomToolsUpdate}
          versionData={versionData}
          saveMode={saveMode}
          versionId={versionId}
          initialEnabledTools={(() => {
            return selectedMCPForTools.enabledTools;
          })()}
        />
      )}
    </div>
  );
};