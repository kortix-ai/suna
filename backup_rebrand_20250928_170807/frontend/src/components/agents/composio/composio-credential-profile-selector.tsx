'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
} from 'lucide-react';
import { useCredentialProfilesForMcp } from '@/hooks/react-query/mcp/use-credential-profiles';

interface ComposioCredentialProfileSelectorProps {
  toolkitSlug: string;
  toolkitName: string;
  selectedProfileId?: string;
  onProfileSelect: (profileId: string | null) => void;
  className?: string;
  showCreateOption?: boolean;
}

export const ComposioCredentialProfileSelector: React.FC<ComposioCredentialProfileSelectorProps> = ({
  toolkitSlug,
  toolkitName,
  selectedProfileId,
  onProfileSelect,
  className,
  showCreateOption = true,
}) => {
  const mcpQualifiedName = toolkitSlug === 'composio' 
    ? 'composio' 
    : `composio.${toolkitSlug}`;
    
  const { data: profiles, isLoading } = useCredentialProfilesForMcp(mcpQualifiedName);

  const selectedProfile = profiles?.find(p => p.profile_id === selectedProfileId);
  const activeProfiles = profiles?.filter(p => p.is_active) || [];

  if (isLoading) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading profiles...</span>
        </div>
      </div>
    );
  }

  if (activeProfiles.length === 0) {
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="text-center py-4">
          <div className="text-sm text-muted-foreground">
            No active {toolkitName} profiles found.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Select
            value={selectedProfileId || ''}
            onValueChange={(value) => onProfileSelect(value || null)}
          >
            <SelectTrigger className="flex-1 w-full">
              <SelectValue placeholder="Select a profile">
                {selectedProfile && (
                  <div className="flex items-center gap-2">
                    <span>{selectedProfile.profile_name}</span>
                    {selectedProfile.is_active ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500" />
                    )}
                  </div>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {activeProfiles.map((profile) => (
                <SelectItem key={profile.profile_id} value={profile.profile_id}>
                  <div className="flex items-center gap-2">
                    <span>{profile.profile_name}</span>
                    <div className="text-xs flex items-center gap-2">
                      <div className="h-2 w-2 bg-green-500 rounded-full" />
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        {selectedProfile && !selectedProfile.is_active && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            This profile is inactive. Please activate it first.
          </p>
        )}
      </div>
    </div>
  );
}; 