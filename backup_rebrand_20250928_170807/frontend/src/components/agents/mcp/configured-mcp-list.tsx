import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Settings, X, Sparkles, Key, AlertTriangle, Trash2 } from 'lucide-react';
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
import { MCPConfiguration } from './types';
import { useCredentialProfilesForMcp } from '@/hooks/react-query/mcp/use-credential-profiles';

import { useComposioToolkits } from '@/hooks/react-query/composio/use-composio';

interface ConfiguredMcpListProps {
  configuredMCPs: MCPConfiguration[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onConfigureTools?: (index: number) => void;
}

const extractAppSlug = (mcp: MCPConfiguration): { type: 'composio', slug: string } | null => {
  if (mcp.customType === 'composio' || mcp.isComposio) {
    const slug = mcp.toolkitSlug || (mcp as any).toolkit_slug || mcp.config?.toolkit_slug;
    if (slug) {
      return { type: 'composio', slug };
    }
    
    const qualifiedName = mcp.mcp_qualified_name || mcp.qualifiedName;
    if (qualifiedName && qualifiedName.startsWith('composio.')) {
      const extractedSlug = qualifiedName.substring(9);
      if (extractedSlug) {
        return { type: 'composio', slug: extractedSlug };
      }
    }
  }
  
  return null;
};

const MCPLogo: React.FC<{ mcp: MCPConfiguration }> = ({ mcp }) => {
  const appInfo = extractAppSlug(mcp);
  
  const { data: composioToolkits } = useComposioToolkits(
    appInfo?.type === 'composio' ? appInfo.slug : undefined,
    undefined
  );
  
  let logoUrl: string | undefined;
  if (appInfo?.type === 'composio' && composioToolkits?.toolkits?.[0]) {
    logoUrl = composioToolkits.toolkits[0].logo;
  }

  const firstLetter = mcp.name.charAt(0).toUpperCase();

  return (
    <div className="w-4 h-4 flex items-center justify-center flex-shrink-0 overflow-hidden">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={mcp.name}
          className="w-full h-full object-cover rounded"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            target.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <div className={logoUrl ? "hidden" : "flex w-full h-full items-center justify-center bg-muted rounded-md text-xs font-medium text-muted-foreground"}>
        {firstLetter}
      </div>
    </div>
  );
};

const MCPConfigurationItem: React.FC<{
  mcp: MCPConfiguration;
  index: number;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onConfigureTools?: (index: number) => void;
}> = ({ mcp, index, onEdit, onRemove, onConfigureTools }) => {
  const qualifiedNameForLookup = (mcp.customType === 'composio' || mcp.isComposio) 
    ? mcp.mcp_qualified_name || mcp.config?.mcp_qualified_name || mcp.qualifiedName
    : mcp.qualifiedName;
  const { data: profiles = [] } = useCredentialProfilesForMcp(qualifiedNameForLookup);
  const profileId = mcp.selectedProfileId || mcp.config?.profile_id;
  const selectedProfile = profiles.find(p => p.profile_id === profileId);
  
  const hasCredentialProfile = !!profileId && !!selectedProfile;

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
      <div className="flex items-center space-x-4 flex-1">
        <div className="p-2 rounded-lg bg-muted border">
          <MCPLogo mcp={mcp} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 mb-1">
            <h4 className="text-sm font-medium truncate">{mcp.name}</h4>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{mcp.enabledTools?.length || 0} tools enabled</span>
            {hasCredentialProfile && (
              <div className="flex items-center gap-1">
                <Key className="h-3 w-3 text-green-600" />
                <span className="text-green-600 font-medium truncate max-w-24">
                  {selectedProfile.profile_name}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center space-x-2 flex-shrink-0">
        {onConfigureTools && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => onConfigureTools(index)}
            title="Configure tools"
            type="button"
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          onClick={() => onRemove(index)}
          title="Remove integration"
          type="button"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export const ConfiguredMcpList: React.FC<ConfiguredMcpListProps> = ({
  configuredMCPs,
  onEdit,
  onRemove,
  onConfigureTools,
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [mcpToDelete, setMcpToDelete] = React.useState<{ mcp: MCPConfiguration; index: number } | null>(null);

  const handleDeleteClick = (mcp: MCPConfiguration, index: number) => {
    setMcpToDelete({ mcp, index });
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (mcpToDelete) {
      onRemove(mcpToDelete.index);
      setMcpToDelete(null);
      setDeleteDialogOpen(false);
    }
  };

  if (configuredMCPs.length === 0) return null;

  return (
    <>
      <div className="space-y-2">
        {configuredMCPs.map((mcp, index) => (
          <MCPConfigurationItem
            key={index}
            mcp={mcp}
            index={index}
            onEdit={onEdit}
            onRemove={(idx) => handleDeleteClick(mcp, idx)}
            onConfigureTools={onConfigureTools}
          />
        ))}
      </div>
      
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Integration</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the "{mcpToDelete?.mcp.name}" integration? This will disconnect all associated tools and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Remove Integration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};