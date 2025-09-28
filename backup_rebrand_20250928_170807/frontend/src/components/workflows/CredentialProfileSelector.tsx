"use client";

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { 
  Plus, 
  Settings, 
  Star, 
  AlertCircle,
  Key,
  Shield,
  Loader2
} from 'lucide-react';
import { 
  useCredentialProfilesForMcp, 
  useSetDefaultProfile,
  useCreateCredentialProfile,
  type CredentialProfile,
  type CreateCredentialProfileRequest
} from '@/hooks/react-query/mcp/use-credential-profiles';
import { useMCPServerDetails } from '@/hooks/react-query/mcp/use-mcp-servers';
import { toast } from 'sonner';

interface CredentialProfileSelectorProps {
  mcpQualifiedName: string;
  mcpDisplayName: string;
  selectedProfileId?: string;
  onProfileSelect: (profileId: string | null, profile: CredentialProfile | null) => void;
  disabled?: boolean;
}

interface InlineCreateProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mcpQualifiedName: string;
  mcpDisplayName: string;
  onSuccess: (profile: CredentialProfile) => void;
}

const InlineCreateProfileDialog: React.FC<InlineCreateProfileDialogProps> = ({
  open,
  onOpenChange,
  mcpQualifiedName,
  mcpDisplayName,
  onSuccess
}) => {
  const [formData, setFormData] = useState<{
    profile_name: string;
    display_name: string;
    config: Record<string, string>;
    is_default: boolean;
  }>({
    profile_name: `${mcpDisplayName} Profile`,
    display_name: mcpDisplayName,
    config: {},
    is_default: false
  });

  const { data: serverDetails, isLoading: isLoadingDetails } = useMCPServerDetails(
    mcpQualifiedName,
    !mcpQualifiedName?.startsWith('composio.')
  );
  const createProfileMutation = useCreateCredentialProfile();

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

  const handleConfigChange = (key: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      config: {
        ...prev.config,
        [key]: value
      }
    }));
  };

  const handleSubmit = async () => {
    try {
      const request: CreateCredentialProfileRequest = {
        mcp_qualified_name: mcpQualifiedName,
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
         mcp_qualified_name: mcpQualifiedName,
         profile_name: formData.profile_name,
         display_name: formData.display_name,
         config_keys: Object.keys(formData.config),
         is_active: true,
         is_default: formData.is_default,
         last_used_at: null,
         created_at: new Date().toISOString(),
         updated_at: new Date().toISOString()
       };
      
      onSuccess(newProfile);
      onOpenChange(false);
      
      // Reset form
      setFormData({
        profile_name: `${mcpDisplayName} Profile`,
        display_name: mcpDisplayName,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5 text-primary" />
            Create Credential Profile
          </DialogTitle>
          <DialogDescription>
            Create a new credential profile for <strong>{mcpDisplayName}</strong>
          </DialogDescription>
        </DialogHeader>

        {isLoadingDetails ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            <span>Loading server configuration...</span>
          </div>
        ) : (
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
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit}
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
  );
};

export function CredentialProfileSelector({
  mcpQualifiedName,
  mcpDisplayName,
  selectedProfileId,
  onProfileSelect,
  disabled = false
}: CredentialProfileSelectorProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  
  const { 
    data: profiles = [], 
    isLoading,
    error,
    refetch
  } = useCredentialProfilesForMcp(mcpQualifiedName);
  
  const setDefaultMutation = useSetDefaultProfile();
  
  const selectedProfile = profiles.find(p => p.profile_id === selectedProfileId);
  
  const handleSetDefault = async (profileId: string) => {
    try {
      await setDefaultMutation.mutateAsync(profileId);
    } catch (error) {
      console.error('Failed to set default profile:', error);
    }
  };

  const handleCreateNewProfile = () => {
    setShowCreateDialog(true);
  };

  const handleCreateSuccess = (newProfile: CredentialProfile) => {
    // Refetch profiles to get the updated list
    refetch();
    // Auto-select the newly created profile
    onProfileSelect(newProfile.profile_id, newProfile);
    toast.success(`Profile "${newProfile.profile_name}" created and selected!`);
  };
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">Failed to load credential profiles</span>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Credential Profile</Label>
          {/* <Button 
            variant="outline" 
            size="sm" 
            disabled={disabled}
            onClick={handleCreateNewProfile}
          >
            <Plus className="h-4 w-4" />
            New Profile
          </Button> */}
        </div>
        
        {profiles.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center">
              <Settings className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-3">
                No credential profiles found for {mcpDisplayName}
              </p>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleCreateNewProfile}
                disabled={disabled}
              >
                <Plus className="h-4 w-4" />
                Create Profile
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            <Select
              value={selectedProfileId || ''}
              onValueChange={(value) => {
                if (value && value.trim() !== '') {
                  const profile = profiles.find(p => p.profile_id === value);
                  if (profile) {
                    onProfileSelect(value, profile);
                  } else {
                    console.error('Selected profile not found:', value);
                    toast.error('Selected profile not found. Please refresh and try again.');
                  }
                } else {
                  onProfileSelect(null, null);
                }
              }}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a credential profile..." />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.profile_id} value={profile.profile_id}>
                    <div className="flex items-center gap-2">
                      <span>{profile.profile_name}</span>
                      {profile.is_default && (
                        <Badge variant="outline" className="text-xs">
                          Default
                        </Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            {selectedProfile && (
              <Card className="bg-muted/30 py-0">
                <CardContent className="p-3">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-medium">{selectedProfile.profile_name}</h4>
                        {selectedProfile.is_default && (
                          <Badge variant="outline" className="text-xs">
                            Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selectedProfile.display_name}
                      </p>
                    </div>
                    {!selectedProfile.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSetDefault(selectedProfile.profile_id)}
                        disabled={setDefaultMutation.isPending}
                      >
                        <Star className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      <InlineCreateProfileDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        mcpQualifiedName={mcpQualifiedName}
        mcpDisplayName={mcpDisplayName}
        onSuccess={handleCreateSuccess}
      />
    </>
  );
} 