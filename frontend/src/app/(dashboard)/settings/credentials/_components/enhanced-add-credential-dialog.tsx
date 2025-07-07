import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, ChevronLeft, ChevronRight, Shield, Loader2, ArrowLeft, Key, ExternalLink, Plus, Globe } from 'lucide-react';
import { usePopularMCPServers, useMCPServers, useMCPServerDetails } from '@/hooks/react-query/mcp/use-mcp-servers';
import { useCreateCredentialProfile, type CreateCredentialProfileRequest } from '@/hooks/react-query/mcp/use-credential-profiles';
import { toast } from 'sonner';

interface EnhancedAddCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface MCPServerCardProps {
  server: any;
  onClick: (server: any) => void;
}

const MCPServerCard: React.FC<MCPServerCardProps> = ({ server, onClick }) => {
  const displayName = server.displayName || server.name;
  const iconUrl = server.iconUrl || server.logo;
  
  return (
    <div 
      className="border rounded-lg p-4 hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => onClick(server)}
    >
      <div className="flex items-start gap-3">
        {iconUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img 
            src={iconUrl} 
            alt={`${displayName} logo`}
            className="w-8 h-8 rounded-md object-cover flex-shrink-0"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium text-sm truncate">{displayName}</h4>
            {server.verified && (
              <Badge variant="secondary" className="text-xs">Verified</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
            {server.description}
          </p>
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="text-xs">
              {server.qualifiedName}
            </Badge>
            {(server.useCount || server.stars) && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>⭐</span>
                <span>{server.useCount || server.stars}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface CategorySidebarProps {
  categories: string[];
  selectedCategory: string | null;
  onCategorySelect: (category: string | null) => void;
  categorizedServers: Record<string, any[]>;
}

const CategorySidebar: React.FC<CategorySidebarProps> = ({
  categories,
  selectedCategory,
  onCategorySelect,
  categorizedServers
}) => {
  return (
    <div className="w-48 pr-4">
      <h3 className="font-medium text-sm mb-3">Categories</h3>
      <div className="space-y-1">
        <button
          onClick={() => onCategorySelect(null)}
          className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
            selectedCategory === null 
              ? 'bg-muted-foreground/10 text-foreground' 
              : 'hover:bg-muted'
          }`}
        >
          All Servers
        </button>
        {categories.map((category) => (
          <button
            key={category}
            onClick={() => onCategorySelect(category)}
            className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors flex items-center justify-between ${
              selectedCategory === category 
                ? 'bg-muted-foreground/10 text-foreground' 
                : 'hover:bg-muted'
            }`}
          >
            <span className="truncate">{category}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export const EnhancedAddCredentialDialog: React.FC<EnhancedAddCredentialDialogProps> = ({ 
  open, 
  onOpenChange, 
  onSuccess 
}) => {
  const [step, setStep] = useState<'browse' | 'configure' | 'custom'>('browse');
  const [selectedServer, setSelectedServer] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(50);
  const [customServerType, setCustomServerType] = useState<'sse' | 'http' | 'json'>('sse');
  const [formData, setFormData] = useState<{
    profile_name: string;
    display_name: string;
    config: Record<string, string>;
    is_default: boolean;
  }>({
    profile_name: '',
    display_name: '',
    config: {},
    is_default: false
  });

  const { data: popularServers, isLoading: isLoading } = usePopularMCPServers(currentPage, pageSize);
  const { data: searchResults, isLoading: isSearching } = useMCPServers(
    searchQuery.length > 2 ? searchQuery : undefined
  );
  const { data: serverDetails, isLoading: isLoadingDetails } = useMCPServerDetails(
    selectedServer?.qualifiedName, 
    !!selectedServer
  );
  const createProfileMutation = useCreateCredentialProfile();

  const categories = popularServers?.success ? Object.keys(popularServers.categorized) : [];

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  useEffect(() => {
    if (open) {
      setCurrentPage(1);
      setSelectedCategory(null);
      setSearchQuery('');
      setStep('browse');
      setSelectedServer(null);
      setCustomServerType('sse');
      setFormData({ 
        profile_name: '', 
        display_name: '', 
        config: {},
        is_default: false
      });
    }
  }, [open]);

  const handleServerSelect = (server: any) => {
    const normalizedServer = {
      ...server,
      displayName: server.displayName || server.name,
      qualifiedName: server.qualifiedName,
      iconUrl: server.iconUrl || server.logo,
      sourceUrl: server.sourceUrl || server.homepage
    };
    
    setSelectedServer(normalizedServer);
    setFormData({
      profile_name: `${normalizedServer.displayName} Profile`,
      display_name: normalizedServer.displayName,
      config: {},
      is_default: false
    });
    setStep('configure');
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
      let request: CreateCredentialProfileRequest;
      if (step === 'custom') {
        const qualifiedName = `custom_${customServerType}_${formData.display_name.toLowerCase().replace(/\s+/g, '_')}`;
        request = {
          mcp_qualified_name: qualifiedName,
          profile_name: formData.profile_name,
          display_name: formData.display_name,
          config: formData.config,
          is_default: formData.is_default
        };
      } else {
        if (!selectedServer) return;
        request = {
          mcp_qualified_name: selectedServer.qualifiedName,
          profile_name: formData.profile_name,
          display_name: formData.display_name,
          config: formData.config,
          is_default: formData.is_default
        };
      }

      await createProfileMutation.mutateAsync(request);
      toast.success('Credential profile created successfully!');
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to create credential profile');
    }
  };

  const handleBack = () => {
    setStep('browse');
    setSelectedServer(null);
  };

  const handleCustomServerSetup = () => {
    setStep('custom');
    setFormData({ 
      profile_name: 'Custom Server Profile', 
      display_name: '', 
      config: {},
      is_default: false
    });
  };

  const getConfigSchema = () => {
    return serverDetails?.connections?.[0]?.configSchema;
  };

  const getConfigProperties = () => {
    const schema = getConfigSchema();
    return schema?.properties || {};
  };

  const getRequiredFields = () => {
    const schema = getConfigSchema();
    return schema?.required || [];
  };

  const isFieldRequired = (fieldName: string) => {
    return getRequiredFields().includes(fieldName);
  };

  const getServersToDisplay = () => {
    if (searchQuery && searchResults) {
      return searchResults.servers || [];
    }

    if (!popularServers?.success) return [];

    if (selectedCategory) {
      return popularServers.categorized[selectedCategory] || [];
    }

    // Flatten all servers from all categories
    return Object.values(popularServers.categorized).flat();
  };

  const serversToDisplay = getServersToDisplay();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'browse' ? 'Create Credential Profile' : 
             step === 'custom' ? 'Create Custom MCP Profile' :
             `Configure ${selectedServer?.displayName} Profile`}
          </DialogTitle>
          <DialogDescription>
            {step === 'browse' 
              ? 'Select an MCP server to create a credential profile for, or add a custom server'
              : step === 'custom'
              ? 'Configure your own custom MCP server credential profile'
              : 'Create a new credential profile for this MCP server'
            }
          </DialogDescription>
        </DialogHeader>

        {step === 'browse' && (
          <>
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search MCP servers..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <div className="flex flex-1 gap-4 overflow-hidden">
              {!searchQuery && categories.length > 0 && (
                <CategorySidebar
                  categories={categories}
                  selectedCategory={selectedCategory}
                  onCategorySelect={setSelectedCategory}
                  categorizedServers={popularServers?.categorized || {}}
                />
              )}
              
              <div className="flex-1 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="space-y-3 p-1">
                    {(isLoading || isSearching) ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin mr-2" />
                        <span>Loading MCP servers...</span>
                      </div>
                    ) : serversToDisplay.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'No servers found matching your search.' : 'No servers available.'}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {serversToDisplay.map((server) => (
                          <MCPServerCard
                            key={server.qualifiedName}
                            server={server}
                            onClick={handleServerSelect}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>

            {!searchQuery && popularServers?.success && popularServers.pagination && (
              <div className="flex items-center justify-between border-t pt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, popularServers.pagination.totalCount)} of {popularServers.pagination.totalCount} servers
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {popularServers.pagination.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.min(popularServers.pagination.totalPages, prev + 1))}
                    disabled={currentPage >= popularServers.pagination.totalPages}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {step === 'configure' && selectedServer && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
              {selectedServer.iconUrl && (
                <img 
                  src={selectedServer.iconUrl} 
                  alt={`${selectedServer.displayName} logo`}
                  className="w-12 h-12 rounded-md object-cover"
                />
              )}
              <div>
                <h3 className="font-medium">{selectedServer.displayName}</h3>
                <p className="text-sm text-muted-foreground">{selectedServer.qualifiedName}</p>
                {selectedServer.sourceUrl && (
                  <a 
                    href={selectedServer.sourceUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
                  >
                    View Documentation <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>

            {isLoadingDetails ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span>Loading server configuration...</span>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="profile_name">Profile Name *</Label>
                    <Input
                      id="profile_name"
                      value={formData.profile_name}
                      onChange={(e) => setFormData(prev => ({ ...prev, profile_name: e.target.value }))}
                      placeholder="Enter a name for this profile (e.g., 'Production Slack')"
                    />
                    <p className="text-xs text-muted-foreground">
                      This helps you identify different configurations for the same MCP server
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="display_name">Display Name</Label>
                    <Input
                      id="display_name"
                      value={formData.display_name}
                      onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
                      placeholder="Enter a display name"
                    />
                  </div>
                </div>

                {Object.keys(getConfigProperties()).length > 0 ? (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold">Connection Settings</h3>
                    {Object.entries(getConfigProperties()).map(([key, schema]: [string, any]) => (
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
            )}
          </div>
        )}

        {step === 'custom' && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
              <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center">
                <Globe className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="font-medium">Custom MCP Server</h3>
                <p className="text-sm text-muted-foreground">Configure your own MCP server connection</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="custom_profile_name">Profile Name *</Label>
                  <Input
                    id="custom_profile_name"
                    value={formData.profile_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, profile_name: e.target.value }))}
                    placeholder="Enter a profile name (e.g., 'My Custom Server')"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="custom_display_name">Display Name *</Label>
                  <Input
                    id="custom_display_name"
                    value={formData.display_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
                    placeholder="Enter a display name for this server"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="server_type">Server Type *</Label>
                <Select value={customServerType} onValueChange={(value: 'sse' | 'http' | 'json') => setCustomServerType(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select server type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sse">SSE (Server-Sent Events)</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="json">JSON/stdio</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Choose the connection type for your MCP server
                </p>
              </div>

              {customServerType === 'json' ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="server_command">Command *</Label>
                    <Input
                      id="server_command"
                      value={formData.config.command || ''}
                      onChange={(e) => handleConfigChange('command', e.target.value)}
                      placeholder="Enter the command to start your MCP server (e.g., 'node server.js')"
                    />
                    <p className="text-xs text-muted-foreground">
                      The command to execute your MCP server
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="server_args">Arguments (optional)</Label>
                    <Input
                      id="server_args"
                      value={formData.config.args || ''}
                      onChange={(e) => handleConfigChange('args', e.target.value)}
                      placeholder="Enter command arguments (comma-separated)"
                    />
                    <p className="text-xs text-muted-foreground">
                      Additional arguments for the command (separated by commas)
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="server_url">Server URL *</Label>
                  <Input
                    id="server_url"
                    type="url"
                    value={formData.config.url || ''}
                    onChange={(e) => handleConfigChange('url', e.target.value)}
                    placeholder={`Enter your ${customServerType.toUpperCase()} server URL`}
                  />
                  <p className="text-xs text-muted-foreground">
                    The URL to your custom MCP server endpoint
                  </p>
                </div>
              )}

              <Alert>
                <Globe className="h-4 w-4" />
                <AlertDescription>
                  This will create a custom MCP server profile that you can use in your agents. 
                  Make sure your server is accessible and properly configured.
                </AlertDescription>
              </Alert>

              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  Your server configuration will be encrypted and stored securely. You can create multiple profiles for different custom servers.
                </AlertDescription>
              </Alert>
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {(step === 'configure' || step === 'custom') && (
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            )}
            {step === 'browse' && (
              <Button variant="outline" onClick={handleCustomServerSetup}>
                <Plus className="h-4 w-4 mr-2" />
                Custom Server
              </Button>
            )}
          </div>
          <Button 
            onClick={step === 'browse' ? () => onOpenChange(false) : handleSubmit}
            disabled={
              (step === 'configure' && (
                !formData.profile_name.trim() ||
                !formData.display_name.trim() || 
                (getRequiredFields().length > 0 && 
                 getRequiredFields().some(field => !formData.config[field])) ||
                createProfileMutation.isPending
              )) ||
              (step === 'custom' && (
                !formData.profile_name.trim() ||
                !formData.display_name.trim() || 
                (customServerType === 'json' ? !formData.config.command : !formData.config.url) ||
                createProfileMutation.isPending
              ))
            }
          >
            {step === 'browse' ? 'Cancel' : 
             createProfileMutation.isPending ? (
               <>
                 <Loader2 className="h-4 w-4 animate-spin" />
                 Creating...
               </>
             ) : 'Create Profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}; 