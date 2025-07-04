import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Save, Sparkles, AlertTriangle, Plus, Key, Settings, Shield } from 'lucide-react';
import { useMCPServerDetails } from '@/hooks/react-query/mcp/use-mcp-servers';

import { 
  useCredentialProfilesForMcp, 
  useCreateCredentialProfile,
  type CredentialProfile,
  type CreateCredentialProfileRequest
} from '@/hooks/react-query/mcp/use-credential-profiles';
import { cn } from '@/lib/utils';
import { MCPConfiguration } from './types';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { CredentialProfileSelector } from '@/components/workflows/CredentialProfileSelector';

interface ConfigDialogProps {
  server: any;
  existingConfig?: MCPConfiguration;
  onSave: (config: MCPConfiguration) => void;
  onCancel: () => void;
}

export const ConfigDialog: React.FC<ConfigDialogProps> = ({ 
  server, 
  existingConfig, 
  onSave, 
  onCancel 
}) => {
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(existingConfig?.enabledTools || [])
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    existingConfig?.selectedProfileId || null
  );
  const [showCreateProfileDialog, setShowCreateProfileDialog] = useState(false);
  const [formData, setFormData] = useState<{
    profile_name: string;
    display_name: string;
    config: Record<string, string>;
    is_default: boolean;
  }>({
    profile_name: `${server.displayName || server.name} Profile`,
    display_name: server.displayName || server.name,
    config: {},
    is_default: false
  });

  const { data: serverDetails, isLoading } = useMCPServerDetails(server.qualifiedName);
  const { data: profiles = [], refetch: refetchProfiles } = useCredentialProfilesForMcp(server.qualifiedName);
  const createProfileMutation = useCreateCredentialProfile();

  const requiresConfig = serverDetails?.connections?.[0]?.configSchema?.properties && 
                        Object.keys(serverDetails.connections[0].configSchema.properties).length > 0;

  const getConfigProperties = () => {
    const schema = serverDetails?.connections?.[0]?.configSchema;
    return schema?.properties || {};
  };

  const getRequiredFields = () => {
    const schema = serverDetails?.connections?.[0]?.configSchema;
    return schema?.required || [];
  };

  const isFieldRequired = (fieldName: string) => {
    return getRequiredFields().includes(fieldName);
  };

  const handleSave = () => {
    const mcpConfig: MCPConfiguration = {
      name: server.displayName || server.name || server.qualifiedName,
      qualifiedName: server.qualifiedName,
      config: {}, // Always use empty config since we're using profiles
      enabledTools: Array.from(selectedTools),
      selectedProfileId: selectedProfileId || undefined,
    };
    onSave(mcpConfig);
  };

  const handleToolToggle = (toolName: string) => {
    const newTools = new Set(selectedTools);
    if (newTools.has(toolName)) {
      newTools.delete(toolName);
    } else {
      newTools.add(toolName);
    }
    setSelectedTools(newTools);
  };

  const handleProfileSelect = (profileId: string | null, profile: CredentialProfile | null) => {
    setSelectedProfileId(profileId);
  };

  const handleCreateNewProfile = () => {
    setShowCreateProfileDialog(true);
  };

  const handleConfigChange = (key: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      config: {
        ...prev.config,
        [key]: value
      }
    }));
  };

  const handleCreateSubmit = async () => {
    try {
      const request: CreateCredentialProfileRequest = {
        mcp_qualified_name: server.qualifiedName,
        profile_name: formData.profile_name,
        display_name: formData.display_name,
        config: formData.config,
        is_default: formData.is_default
      };

      const response = await createProfileMutation.mutateAsync(request);
      toast.success('Credential profile created successfully!');
      
      // Create a profile object to return
      const newProfile: CredentialProfile = {
        profile_id: response.profile_id || 'new-profile',
        mcp_qualified_name: server.qualifiedName,
        profile_name: formData.profile_name,
        display_name: formData.display_name,
        config_keys: Object.keys(formData.config),
        is_active: true,
        is_default: formData.is_default,
        last_used_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      // Refetch profiles to get the updated list
      refetchProfiles();
      // Auto-select the newly created profile
      setSelectedProfileId(newProfile.profile_id);
      setShowCreateProfileDialog(false);
      
      // Reset form
      setFormData({
        profile_name: `${server.displayName || server.name} Profile`,
        display_name: server.displayName || server.name,
        config: {},
        is_default: false
      });
    } catch (error: any) {
      toast.error(error.message || 'Failed to create credential profile');
    }
  };

  const configProperties = getConfigProperties();
  const hasConfigFields = Object.keys(configProperties).length > 0;

  return (
    <>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3 mb-2">
            {server.iconUrl ? (
              <div className="relative">
                <img 
                  src={server.iconUrl} 
                  alt={server.displayName || server.name} 
                  className="w-8 h-8 rounded-lg shadow-sm" 
                />
                <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent rounded-lg pointer-events-none" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shadow-sm border border-primary/20">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
            )}
            <div>
              <DialogTitle className="text-lg">Configure {server.displayName || server.name}</DialogTitle>
            </div>
          </div>
          <DialogDescription>
            Set up the connection and select which tools to enable for this MCP server.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-2 gap-6 px-1">
            <div className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <div className="w-1 h-4 bg-primary rounded-full" />
                  Connection Settings
                </h3>
                {requiresConfig && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={handleCreateNewProfile}
                  >
                    <Plus className="h-4 w-4" />
                    New Profile
                  </Button>
                )}
              </div>
              
              {requiresConfig ? (
                <div className="space-y-4">
                  <CredentialProfileSelector
                    mcpQualifiedName={server.qualifiedName}
                    mcpDisplayName={server.displayName || server.name}
                    selectedProfileId={selectedProfileId || undefined}
                    onProfileSelect={handleProfileSelect}
                  />
                  
                  {!selectedProfileId && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        Please select or create a credential profile to configure this MCP server.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Card className="border-dashed border-2 w-full">
                    <CardContent className="p-6 text-center">
                      <p className="text-sm">No configuration required for this MCP server</p>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>

            <div className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <div className="w-1 h-4 bg-primary rounded-full" />
                  Available Tools
                </h3>
                {serverDetails?.tools && serverDetails.tools.length > 0 && (
                  <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-full">
                    {selectedTools.size} of {serverDetails.tools.length} selected
                  </span>
                )}
              </div>
              {serverDetails?.tools && serverDetails.tools.length > 0 ? (
                <ScrollArea className="-mt-1 border bg-muted/30 rounded-lg p-4 flex-1 min-h-0">
                  <div>
                    <div className="space-y-2">
                      {serverDetails.tools.map((tool: any) => (
                        <div
                          key={tool.name}
                          className={cn(
                            "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200",
                            selectedTools.has(tool.name)
                              ? "bg-primary/10 border-primary/30 shadow-sm"
                              : "hover:bg-muted/30 border-border/50 hover:border-border"
                          )}
                          onClick={() => handleToolToggle(tool.name)}
                        >
                          <input
                            type="checkbox"
                            checked={selectedTools.has(tool.name)}
                            onChange={() => {}}
                            className="mt-1 accent-primary"
                          />
                          <div className="flex-1">
                            <div className="font-medium text-sm">{tool.name}</div>
                            {tool.description && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {tool.description}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Card className="border-dashed border-2 w-full">
                    <CardContent className="p-6 text-center">
                      <p className="text-sm">No tools available for this MCP server</p>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={isLoading || (requiresConfig && !selectedProfileId)}
            className="bg-primary hover:bg-primary/90"
          >
            <Save className="h-4 w-4" />
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Create Profile Dialog */}
      <Dialog open={showCreateProfileDialog} onOpenChange={setShowCreateProfileDialog}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-5 w-5 text-primary" />
              Create Credential Profile
            </DialogTitle>
            <DialogDescription>
              Create a new credential profile for <strong>{server.displayName || server.name}</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 flex-1 overflow-y-auto">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="profile_name">Profile Name *</Label>
                  <Input
                    id="profile_name"
                    value={formData.profile_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, profile_name: e.target.value }))}
                    placeholder="Enter a name for this profile"
                  />
                  <p className="text-xs text-muted-foreground">
                    This helps you identify different configurations for the same MCP server
                  </p>
                </div>
              </div>

              {hasConfigFields ? (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Settings className="h-4 w-4" />
                    Connection Settings
                  </h3>
                  {Object.entries(configProperties).map(([key, schema]: [string, any]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={key}>
                        {schema.title || key}
                        {isFieldRequired(key) && (
                          <span className="text-destructive ml-1">*</span>
                        )}
                      </Label>
                      <Input
                        id={key}
                        type={schema.format === 'password' ? 'password' : 'text'}
                        placeholder={schema.description || `Enter ${key}`}
                        value={formData.config[key] || ''}
                        onChange={(e) => handleConfigChange(key, e.target.value)}
                      />
                      {schema.description && (
                        <p className="text-xs text-muted-foreground">{schema.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Alert>
                  <Key className="h-4 w-4" />
                  <AlertDescription>
                    This MCP server doesn't require any API credentials to use.
                  </AlertDescription>
                </Alert>
              )}

              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  Your credentials will be encrypted and stored securely. You can create multiple profiles for the same MCP server to handle different use cases.
                </AlertDescription>
              </Alert>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateProfileDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateSubmit}
              disabled={!formData.profile_name.trim() || createProfileMutation.isPending}
            >
              {createProfileMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  Create Profile
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};