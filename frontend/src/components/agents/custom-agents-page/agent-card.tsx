'use client';

import React from 'react';
import { Download, CheckCircle, Loader2, Globe, GlobeLock, GitBranch, Trash2, MoreVertical, User } from 'lucide-react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { UnifiedAgentCard, type BaseAgentData, type AgentCardVariant } from '@/components/ui/unified-agent-card';

export type AgentCardMode = 'marketplace' | 'template' | 'agent';

interface LegacyBaseAgentData {
  id: string;
  name: string;
  tags?: string[];
  created_at: string;
}

interface MarketplaceData extends LegacyBaseAgentData {
  creator_id: string;
  is_kortix_team?: boolean;
  download_count: number;
  creator_name?: string;
  marketplace_published_at?: string;
}

interface TemplateData extends LegacyBaseAgentData {
  template_id: string;
  is_public?: boolean;
  download_count?: number;
}

interface AgentData extends LegacyBaseAgentData {
  agent_id: string;
  is_default?: boolean;
  is_public?: boolean;
  marketplace_published_at?: string;
  download_count?: number;
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
    profile_image_url?: string;
  };
}

type AgentCardData = MarketplaceData | TemplateData | AgentData;

interface AgentCardProps {
  mode: AgentCardMode;
  data: AgentCardData;
  styling?: {
    avatar: string;
    color: string;
  };
  isActioning?: boolean;
  onPrimaryAction?: (data: any, e?: React.MouseEvent) => void;
  onSecondaryAction?: (data: any, e?: React.MouseEvent) => void;
  onDeleteAction?: (data: any, e?: React.MouseEvent) => void;
  onClick?: (data: any) => void;
  currentUserId?: string;
}

const MarketplaceBadge: React.FC<{ 
  isKortixTeam?: boolean; 
  isOwner?: boolean;
}> = ({ isKortixTeam, isOwner }) => {
  return (
    <div className="flex gap-1 flex-wrap">
      {isKortixTeam && (
        <Badge variant="secondary" className="bg-blue-100 text-blue-700 border-0 dark:bg-blue-950 dark:text-blue-300">
          <CheckCircle className="h-3 w-3 mr-1" />
          Kortix
        </Badge>
      )}
      {isOwner && (
        <Badge variant="secondary" className="bg-green-100 text-green-700 border-0 dark:bg-green-950 dark:text-green-300">
          Owner
        </Badge>
      )}
    </div>
  );
};

const TemplateBadge: React.FC<{ isPublic?: boolean }> = ({ isPublic }) => {
  if (isPublic) {
    return (
      <Badge variant="default" className="bg-green-100 text-green-700 border-0 dark:bg-green-950 dark:text-green-300">
        <Globe className="h-3 w-3" />
        Public
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-gray-100 text-gray-700 border-0 dark:bg-gray-800 dark:text-gray-300">
      <GlobeLock className="h-3 w-3" />
      Private
    </Badge>
  );
};

const AgentBadges: React.FC<{ agent: AgentData, isSunaAgent: boolean }> = ({ agent, isSunaAgent }) => (
  <div className="flex gap-1">
    {!isSunaAgent && agent.current_version && (
      <Badge variant="outline" className="text-xs">
        <GitBranch className="h-3 w-3 mr-1" />
        {agent.current_version.version_name}
      </Badge>
    )}
    {!isSunaAgent && agent.is_public && (
      <Badge variant="default" className="bg-green-100 text-green-700 border-0 dark:bg-green-950 dark:text-green-300 text-xs">
        <Globe className="h-3 w-3 mr-1" />
        Published
      </Badge>
    )}
  </div>
);

const MarketplaceMetadata: React.FC<{ data: MarketplaceData }> = ({ data }) => (
  <div className="flex items-center justify-between text-xs text-muted-foreground">
    <div className="flex items-center gap-1">
      <User className="h-3 w-3" />
      <span>{data.creator_name || 'Anonymous'}</span>
    </div>
    <div className="flex items-center gap-1">
      <Download className="h-3 w-3" />
      <span>{data.download_count} installs</span>
    </div>
  </div>
);

const TemplateMetadata: React.FC<{ data: TemplateData }> = ({ data }) => (
  <div className="space-y-1 text-xs text-muted-foreground">
    {data.is_public && data.download_count !== undefined && data.download_count > 0 && (
      <div className="flex items-center gap-1">
        <Download className="h-3 w-3" />
        <span>{data.download_count} downloads</span>
      </div>
    )}
  </div>
);

const AgentMetadata: React.FC<{ data: AgentData }> = ({ data }) => (
  <div className="space-y-1 text-xs text-muted-foreground">
    {data.is_public && data.marketplace_published_at && data.download_count != null && data.download_count > 0 && (
      <div className="flex items-center gap-1">
        <Download className="h-3 w-3" />
        <span>{data.download_count} downloads</span>
      </div>
    )}
  </div>
);

const MarketplaceActions: React.FC<{ 
  onAction?: (data: any, e?: React.MouseEvent) => void;
  onDeleteAction?: (data: any, e?: React.MouseEvent) => void;
  isActioning?: boolean;
  data: any;
  currentUserId?: string;
}> = ({ onAction, onDeleteAction, isActioning, data, currentUserId }) => {
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const isOwner = currentUserId && data.creator_id === currentUserId;

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = () => {
    setShowDeleteDialog(false);
    onDeleteAction?.(data);
  };

  return (
    <>
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <Button 
          onClick={(e) => {
            e.stopPropagation();
            onAction?.(data, e);
          }}
          disabled={isActioning}
          className="flex-1"
          size="sm"
        >
          {isActioning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Installing...
            </>
          ) : (
            <>
              <Download className="h-4 w-4 mr-2" />
              Install
            </>
          )}
        </Button>
        
        {isOwner && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="outline" 
                size="sm"
                className="px-2"
                disabled={isActioning}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={handleDeleteClick}
              >
                <Trash2 className="h-4 w-4" />
                Delete Template
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "<strong>{data.name}</strong>"? This will permanently remove it from the marketplace and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.stopPropagation();
                handleConfirmDelete();
              }}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {isActioning ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Template'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const TemplateActions: React.FC<{ 
  data: TemplateData;
  onPrimaryAction?: (data: any, e?: React.MouseEvent) => void;
  onSecondaryAction?: (data: any, e?: React.MouseEvent) => void;
  isActioning?: boolean;
}> = ({ data, onPrimaryAction, onSecondaryAction, isActioning }) => (
  <div className="space-y-2">
    {data.is_public ? (
      <>
        <Button
          onClick={(e) => onPrimaryAction?.(data, e)}
          disabled={isActioning}
          variant="outline"
          className="w-full"
          size="sm"
        >
          {isActioning ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin " />
              Unpublishing...
            </>
          ) : (
            <>
              <GlobeLock className="h-3 w-3 " />
              Make Private
            </>
          )}
        </Button>
      </>
    ) : (
      <Button
        onClick={(e) => onPrimaryAction?.(data, e)}
        disabled={isActioning}
        variant="default"
        className="w-full"
        size="sm"
      >
        {isActioning ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin " />
            Publishing...
          </>
        ) : (
          <>
            <Globe className="h-3 w-3 " />
            Publish to Marketplace
          </>
        )}
      </Button>
    )}
  </div>
);

const CardAvatar: React.FC<{ 
  isSunaAgent?: boolean; 
  profileImageUrl?: string; 
  agentName?: string;
  iconName?: string;
  iconColor?: string;
  iconBackground?: string;
}> = ({ 
  isSunaAgent = false, 
  profileImageUrl, 
  agentName,
  iconName,
  iconColor = '#000000',
  iconBackground = '#F3F4F6'
}) => {
  if (isSunaAgent) {
    return (
      <div className="h-14 w-14 bg-muted border flex items-center justify-center rounded-2xl">
        <KortixLogo size={28} />
      </div>
    )
  }
  
  if (iconName) {
    return (
      <div 
        className="h-14 w-14 flex border items-center justify-center rounded-2xl"
        style={{ backgroundColor: iconBackground }}
      >
        <DynamicIcon 
          name={iconName as any} 
          size={28} 
          color={iconColor}
        />
      </div>
    );
  }
  
  if (profileImageUrl) {
    return (
      <img src={profileImageUrl} alt="Agent" className="h-14 w-14 rounded-2xl object-cover" />
    );
  }
  
  return (
    <div className="h-14 w-14 border bg-muted flex items-center justify-center rounded-2xl">
      <span className="text-lg font-semibold">{agentName?.charAt(0).toUpperCase() || '?'}</span>
    </div>
  )
};

const TagList: React.FC<{ tags?: string[] }> = ({ tags }) => {
  return (
    <div className="flex flex-wrap gap-1 min-h-[1.25rem]">
      {tags && tags.length > 0 && (
        <>
          {tags.slice(0, 2).map(tag => (
            <Badge key={tag} variant="outline" className="text-xs border-border/50">
              {tag}
            </Badge>
          ))}
          {tags.length > 2 && (
            <Badge variant="outline" className="text-xs border-border/50">
              +{tags.length - 2}
            </Badge>
          )}
        </>
      )}
    </div>
  );
};


export const AgentCard: React.FC<AgentCardProps> = ({
  mode,
  data,
  styling,
  isActioning = false,
  onPrimaryAction,
  onSecondaryAction,
  onDeleteAction,
  onClick,
  currentUserId
}) => {
  // Convert legacy mode to new variant
  const getVariant = (mode: AgentCardMode): AgentCardVariant => {
    switch (mode) {
      case 'marketplace':
        return 'marketplace';
      case 'template':
        return 'template';
      case 'agent':
        return 'agent';
      default:
        return 'agent';
    }
  };

  // Convert legacy data to BaseAgentData
  const convertToBaseAgentData = (data: AgentCardData): BaseAgentData => {
    const baseData: BaseAgentData = {
      id: data.id,
      name: data.name,
      tags: data.tags,
      created_at: data.created_at,
    };

    // Add mode-specific fields
    if (mode === 'marketplace') {
      const marketplaceData = data as MarketplaceData;
      return {
        ...baseData,
        creator_id: marketplaceData.creator_id,
        creator_name: marketplaceData.creator_name,
        is_kortix_team: marketplaceData.is_kortix_team,
        download_count: marketplaceData.download_count,
        marketplace_published_at: marketplaceData.marketplace_published_at,
        profile_image_url: (data as any)?.profile_image_url,
        icon_name: (data as any)?.icon_name,
        icon_color: (data as any)?.icon_color,
        icon_background: (data as any)?.icon_background,
      };
    }

    if (mode === 'template') {
      const templateData = data as TemplateData;
      return {
        ...baseData,
        template_id: templateData.template_id,
        is_public: templateData.is_public,
        download_count: templateData.download_count,
        profile_image_url: (data as any)?.profile_image_url,
        icon_name: (data as any)?.icon_name,
        icon_color: (data as any)?.icon_color,
        icon_background: (data as any)?.icon_background,
      };
    }

    if (mode === 'agent') {
      const agentData = data as AgentData;
      return {
        ...baseData,
        agent_id: agentData.agent_id,
        is_default: agentData.is_default,
        is_public: agentData.is_public,
        marketplace_published_at: agentData.marketplace_published_at,
        download_count: agentData.download_count,
        current_version: agentData.current_version,
        metadata: agentData.metadata,
        profile_image_url: (data as any)?.profile_image_url,
        icon_name: (data as any)?.icon_name,
        icon_color: (data as any)?.icon_color,
        icon_background: (data as any)?.icon_background,
      };
    }

    return baseData;
  };

  return (
    <UnifiedAgentCard
      variant={getVariant(mode)}
      data={convertToBaseAgentData(data)}
      actions={{
        onPrimaryAction,
        onSecondaryAction,
        onDeleteAction,
        onClick,
      }}
      state={{
        isActioning,
      }}
      currentUserId={currentUserId}
    />
  );
}; 