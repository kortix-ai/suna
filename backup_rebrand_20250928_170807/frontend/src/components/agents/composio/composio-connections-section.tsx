'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Eye,
  EyeOff,
  Copy,
  Settings,
  ExternalLink,
  Crown,
  Search,
  X,
  Plus,
  CheckCircle2,
  XCircle,
  Trash2,
} from 'lucide-react';
import { useComposioCredentialsProfiles, useComposioMcpUrl } from '@/hooks/react-query/composio/use-composio-profiles';
import { useDeleteProfile, useBulkDeleteProfiles, useSetDefaultProfile } from '@/hooks/react-query/composio/use-composio-mutations';
import { ComposioRegistry } from './composio-registry';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { ComposioProfileSummary, ComposioToolkitGroup } from '@/hooks/react-query/composio/utils';

interface ComposioConnectionsSectionProps {
  className?: string;
}

interface McpUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  profileName: string;
  toolkitName: string;
}

interface ToolkitTableProps {
  toolkit: ComposioToolkitGroup;
}

interface DeleteConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProfiles: ComposioProfileSummary[];
  onConfirm: () => void;
  isDeleting: boolean;
}

const DeleteConfirmationDialog: React.FC<DeleteConfirmationDialogProps> = ({
  open,
  onOpenChange,
  selectedProfiles,
  onConfirm,
  isDeleting,
}) => {
  const isSingle = selectedProfiles.length === 1;
  
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isSingle ? 'Delete Profile' : `Delete ${selectedProfiles.length} Profiles`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isSingle 
              ? `Are you sure you want to delete "${selectedProfiles[0]?.profile_name}"? This action cannot be undone.`
              : `Are you sure you want to delete ${selectedProfiles.length} profiles? This action cannot be undone.`
            }
            <div className="mt-2 text-amber-600 dark:text-amber-400">
              <strong>Warning:</strong> This may affect existing integrations.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction 
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const McpUrlDialog: React.FC<McpUrlDialogProps> = ({
  open,
  onOpenChange,
  profileId,
  profileName,
  toolkitName,
}) => {
  const [showUrl, setShowUrl] = useState(false);
  const { data: urlData, isLoading, error } = useComposioMcpUrl(profileId, open);

  const { data: toolkits } = useComposioCredentialsProfiles();
  const currentToolkit = useMemo(() => {
    if (!toolkits) return null;
    return toolkits.find(toolkit => 
      toolkit.profiles.some(p => p.profile_id === profileId)
    );
  }, [toolkits, profileId]);

  const copyToClipboard = async () => {
    if (urlData?.mcp_url) {
      try {
        await navigator.clipboard.writeText(urlData.mcp_url);
        toast.success('MCP URL copied to clipboard');
      } catch (err) {
        toast.error('Failed to copy URL');
      }
    }
  };

  const maskUrl = (url: string) => {
    if (!url) return '';
    const parts = url.split('/');
    if (parts.length > 2) {
      const domain = parts[2];
      return `https://${domain}/.../**********`;
    }
    return url.slice(0, 20) + '...';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="h-14 w-14 rounded-lg bg-muted border flex items-center justify-center overflow-hidden">
              {currentToolkit?.icon_url ? (
                <img 
                  src={currentToolkit.icon_url} 
                  alt={`${toolkitName} icon`}
                  className="h-8 w-8 object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                  }}
                />
              ) : null}
              <Settings className={`h-4 w-4 text-muted-foreground ${currentToolkit?.icon_url ? 'hidden' : ''}`} />
            </div>
            <div>
              <span>{profileName}</span>
              <div onClick={() => window.open('https://composio.dev', '_blank')} className="hover:underline cursor-pointer text-sm text-muted-foreground flex items-center gap-1 mt-1">
                <ExternalLink className="h-3 w-3" />
                <span>composio.dev</span>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <Alert className="border-amber-400/50 dark:border-amber-600/30 bg-amber-400/10 dark:bg-amber-900/10">
            <AlertDescription className="text-amber-800 dark:text-amber-600">
              <strong>Security Warning:</strong> This MCP URL contains sensitive authentication 
              information and must not be shared. Anyone with access to this URL can perform actions on your behalf.
            </AlertDescription>
          </Alert>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">MCP Connection URL</label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUrl(!showUrl)}
                className="text-muted-foreground hover:text-foreground"
              >
                {showUrl ? (
                  <>
                    <EyeOff className="h-4 w-4" />
                    Hide
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" />
                    Show
                  </>
                )}
              </Button>
            </div>
            {isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : error ? (
              <Alert className="border-red-200 bg-red-50">
                <XCircle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800">
                  Failed to load MCP URL. Please try again.
                </AlertDescription>
              </Alert>
            ) : urlData ? (
              <div className="relative">
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border font-mono text-sm">
                  <code className="flex-1 break-all">
                    {showUrl ? urlData.mcp_url : maskUrl(urlData.mcp_url)}
                  </code>
                  {showUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={copyToClipboard}
                      className="flex-shrink-0"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-2 rounded-full bg-blue-500" />
                      <span>Streamable HTTP</span>
                    </div>
                  </div>
                  {showUrl && (
                    <span className="font-mono">{urlData.mcp_url.length} chars</span>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const ToolkitTable: React.FC<ToolkitTableProps> = ({ toolkit }) => {
  const [selectedProfile, setSelectedProfile] = useState<{
    profileId: string;
    profileName: string;
    toolkitName: string;
  } | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<ComposioProfileSummary[]>([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const deleteProfile = useDeleteProfile();
  const bulkDeleteProfiles = useBulkDeleteProfiles();
  const setDefaultProfile = useSetDefaultProfile();

  const handleViewUrl = (profileId: string, profileName: string, toolkitName: string) => {
    setSelectedProfile({ profileId, profileName, toolkitName });
  };

  const handleDeleteSelected = () => {
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    if (selectedProfiles.length === 1) {
      await deleteProfile.mutateAsync(selectedProfiles[0].profile_id);
    } else {
      await bulkDeleteProfiles.mutateAsync(selectedProfiles.map(p => p.profile_id));
    }
    setSelectedProfiles([]);
    setShowDeleteDialog(false);
  };

  const handleSetDefault = async (profileId: string) => {
    await setDefaultProfile.mutateAsync(profileId);
  };

  const isDeleting = deleteProfile.isPending || bulkDeleteProfiles.isPending;

  const columns: DataTableColumn<ComposioProfileSummary>[] = [
    {
      id: 'name',
      header: 'Profile Name',
      width: 'w-1/3',
      cell: (profile) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{profile.profile_name}</span>
          {profile.is_default && (
            <span title="Default profile">
              <Crown className="h-4 w-4 text-amber-500" />
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'mcp_url',
      header: 'MCP URL',
      width: 'w-1/3',
      cell: (profile) => (
        <div className="flex items-center gap-2">
          {profile.has_mcp_url ? (
            <div className="flex items-center gap-2">
              <code className="text-xs flex items-center gap-2 font-mono text-muted-foreground bg-muted px-2 py-1 rounded-md">
                https://mcp.composio.dev/...
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleViewUrl(profile.profile_id, profile.profile_name, toolkit.toolkit_name)}
                    className="h-6 text-xs"
                >
                  <Eye className="h-3 w-3" />
                </Button>
              </code>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No URL available</span>
          )}
        </div>
      ),
    },
    // {
    //   id: 'status',
    //   header: 'Status',
    //   width: 'w-1/6',
    //   cell: (profile) => (
    //     <div className="flex items-center gap-2">
    //       {profile.is_connected ? (
    //         <div className="flex items-center gap-2 text-xs text-muted-foreground">
    //           <div className="h-2 w-2 rounded-full bg-green-500" />
    //           Connected
    //         </div>
    //       ) : (
    //         <div className="flex items-center gap-2 text-xs text-muted-foreground">
    //           <div className="h-2 w-2 rounded-full bg-destructive" />
    //           Disconnected
    //         </div>
    //       )}
    //     </div>
    //   ),
    // },
    {
      id: 'actions',
      header: 'Actions',
      width: 'w-1/6',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (profile) => (
        <div className="flex items-center justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {profile.has_mcp_url && (
                <>
                  <DropdownMenuItem className="rounded-lg" onClick={() => handleViewUrl(profile.profile_id, profile.profile_name, toolkit.toolkit_name)}>
                    <Eye className="h-4 w-4" />
                    View MCP URL
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem className="rounded-lg" onClick={() => handleSetDefault(profile.profile_id)} disabled={setDefaultProfile.isPending}>
                <CheckCircle2 className="h-4 w-4" />
                {profile.is_default ? 'Remove Default' : 'Set as Default'}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => {
                  setSelectedProfiles([profile]);
                  setShowDeleteDialog(true);
                }}
                className="text-destructive rounded-lg focus:text-destructive focus:bg-destructive/10"
                disabled={isDeleting}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
                Delete Profile
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted border flex items-center justify-center overflow-hidden">
            {toolkit.icon_url ? (
              <img 
                src={toolkit.icon_url} 
                alt={`${toolkit.toolkit_name} icon`}
                className="h-6 w-6 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <Settings className={`h-4 w-4 text-muted-foreground ${toolkit.icon_url ? 'hidden' : ''}`} />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{toolkit.toolkit_name}</h3>
            <p className="text-xs text-muted-foreground">
              {toolkit.profiles.length} profile{toolkit.profiles.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      <DataTable
        data={toolkit.profiles}
        columns={columns}
        className="rounded-lg border"
        selectable={true}
        selectedItems={selectedProfiles}
        onSelectionChange={setSelectedProfiles}
        getItemId={(profile) => profile.profile_id}
        headerActions={
          selectedProfiles.length > 0 ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteSelected}
              disabled={isDeleting}
            >
              <Trash2 className="h-4 w-4" />
              Delete {selectedProfiles.length > 1 ? `${selectedProfiles.length} Profiles` : 'Profile'}
            </Button>
          ) : null
        }
      />
      
      {selectedProfile && (
        <McpUrlDialog
          open={!!selectedProfile}
          onOpenChange={(open) => !open && setSelectedProfile(null)}
          profileId={selectedProfile.profileId}
          profileName={selectedProfile.profileName}
          toolkitName={selectedProfile.toolkitName}
        />
      )}
      
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        selectedProfiles={selectedProfiles}
        onConfirm={handleConfirmDelete}
        isDeleting={isDeleting}
      />
    </div>
  );
};

export const ComposioConnectionsSection: React.FC<ComposioConnectionsSectionProps> = ({
  className,
}) => {
  const { data: toolkits, isLoading, error } = useComposioCredentialsProfiles();
  const [searchQuery, setSearchQuery] = useState('');
  const [showRegistry, setShowRegistry] = useState(false);
  const queryClient = useQueryClient();

  const filteredToolkits = useMemo(() => {
    if (!toolkits || !searchQuery.trim()) return toolkits || [];
    
    return toolkits.filter(toolkit => 
      toolkit.toolkit_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      toolkit.profiles.some(profile => 
        profile.profile_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    ).map(toolkit => ({
      ...toolkit,
      profiles: toolkit.profiles.filter(profile =>
        profile.profile_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        toolkit.toolkit_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    })).filter(toolkit => toolkit.profiles.length > 0);
  }, [toolkits, searchQuery]);

  const stats = useMemo(() => {
    if (!toolkits) return { totalProfiles: 0, connectedProfiles: 0, uniqueToolkits: 0 };
    
    const totalProfiles = toolkits.reduce((acc, toolkit) => acc + toolkit.profiles.length, 0);
    const connectedProfiles = toolkits.reduce(
      (acc, toolkit) => acc + toolkit.profiles.filter(p => p.is_connected).length, 
      0
    );
    const uniqueToolkits = toolkits.length;
    
    return { totalProfiles, connectedProfiles, uniqueToolkits };
  }, [toolkits]);

  const filteredStats = useMemo(() => {
    const filteredProfilesCount = filteredToolkits.reduce((acc, toolkit) => acc + toolkit.profiles.length, 0);
    const filteredToolkitsCount = filteredToolkits.length;
    
    return { filteredProfilesCount, filteredToolkitsCount };
  }, [filteredToolkits]);

  const handleProfileCreated = (profileId: string, selectedTools: string[], appName: string, appSlug: string) => {
    setShowRegistry(false);
    queryClient.invalidateQueries({ queryKey: ['composio', 'profiles'] });
    toast.success(`Successfully connected ${appName}!`);
  };

  if (isLoading) {
    return (
      <div className={cn("space-y-6", className)}>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={index}>
              <CardHeader>
                <Skeleton className="h-6 w-48" />
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Array.from({ length: 2 }).map((_, profileIndex) => (
                    <Skeleton key={profileIndex} className="h-16 w-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("space-y-6", className)}>
        <Alert className="border-red-200 bg-red-50">
          <XCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-800">
            Failed to load Composio connections. Please try again.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!toolkits || toolkits.length === 0) {
    return (
      <div className={cn("space-y-6", className)}>
        <Card className="border-dashed">
          <CardContent className="py-12">
            <div className="text-center">
              <Settings className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No Connections</h3>
              <p className="text-muted-foreground">
                Connect integrations to your agents and you will be able to manage them here.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {searchQuery 
              ? `${filteredStats.filteredToolkitsCount} ${filteredStats.filteredToolkitsCount === 1 ? 'app' : 'apps'} with ${filteredStats.filteredProfilesCount} ${filteredStats.filteredProfilesCount === 1 ? 'profile' : 'profiles'} found`
              : `${stats.uniqueToolkits} ${stats.uniqueToolkits === 1 ? 'app' : 'apps'} with ${stats.totalProfiles} ${stats.totalProfiles === 1 ? 'profile' : 'profiles'} (${stats.connectedProfiles} connected)`
            }
          </p>
        </div>
        <Button
          onClick={() => setShowRegistry(true)}
          size="sm"
        >
          <Plus className="h-4 w-4" />
          Connect New App
        </Button>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search apps and profiles..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-12 h-12 rounded-xl bg-muted/50 border-0 focus:bg-background focus:ring-2 focus:ring-primary/20 transition-all"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSearchQuery('')}
            className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0 hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      {filteredToolkits.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center">
            <div className="space-y-4">
              <div className="p-3 rounded-full bg-muted/50 w-fit mx-auto">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <h3 className="font-semibold text-foreground">No results found</h3>
                <p className="text-sm text-muted-foreground">
                  Try adjusting your search terms or browse all apps
                </p>
              </div>
              <Button 
                onClick={() => setSearchQuery('')}
                variant="outline"
                size="sm"
              >
                Clear search
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {filteredToolkits
            .sort((a, b) => {
              const aConnected = a.profiles.filter(p => p.is_connected).length;
              const bConnected = b.profiles.filter(p => p.is_connected).length;
              if (aConnected !== bConnected) return bConnected - aConnected;
              return b.profiles.length - a.profiles.length;
            })
            .map((toolkit) => (
              <ToolkitTable key={toolkit.toolkit_slug} toolkit={toolkit} />
            ))}
        </div>
      )}

      <Dialog open={showRegistry} onOpenChange={setShowRegistry}>
        <DialogContent className="p-0 max-w-6xl h-[90vh] overflow-hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Connect New App</DialogTitle>
          </DialogHeader>
          <ComposioRegistry
            mode="profile-only"
            onClose={() => setShowRegistry(false)}
            onToolsSelected={handleProfileCreated}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}; 