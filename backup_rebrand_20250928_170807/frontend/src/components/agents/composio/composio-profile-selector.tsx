import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Calendar, User } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import type { ComposioToolkit, ComposioProfile } from '@/hooks/react-query/composio/utils';

interface ComposioProfileSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolkit: ComposioToolkit;
  existingProfiles: ComposioProfile[];
  onSelectProfile: (profile: ComposioProfile) => void;
  onCreateNew: () => void;
}

export const ComposioProfileSelector: React.FC<ComposioProfileSelectorProps> = ({
  open,
  onOpenChange,
  toolkit,
  existingProfiles,
  onSelectProfile,
  onCreateNew,
}) => {
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  const handleContinue = () => {
    if (selectedProfileId === 'new') {
      onCreateNew();
      onOpenChange(false);
    } else if (selectedProfileId) {
      const profile = existingProfiles.find(p => p.profile_id === selectedProfileId);
      if (profile) {
        onSelectProfile(profile);
        onOpenChange(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select {toolkit.name} Profile</DialogTitle>
          <DialogDescription>
            Choose an existing connection or create a new one
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Connection Profile</label>
            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a profile..." />
              </SelectTrigger>
              <SelectContent>
                {existingProfiles.map((profile) => (
                  <SelectItem key={profile.profile_id} value={profile.profile_id}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <div className="font-medium">{profile.profile_name}</div>
                        <div className="text-xs text-muted-foreground">
                          Connected {formatDistanceToNow(new Date(profile.created_at), { addSuffix: true })}
                        </div>
                      </div>
                    </div>
                  </SelectItem>
                ))}
                <SelectItem value="new">
                  <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    <span>Create New Connection</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedProfileId && selectedProfileId !== 'new' && (
            <div className="rounded-lg bg-muted/50 p-3 space-y-1">
              <div className="text-sm font-medium">Profile Details</div>
              {(() => {
                const profile = existingProfiles.find(p => p.profile_id === selectedProfileId);
                if (!profile) return null;
                
                return (
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div className="flex items-center gap-2">
                      <User className="h-3 w-3" />
                      <span>{profile.profile_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-3 w-3" />
                      <span>Created {formatDistanceToNow(new Date(profile.created_at), { addSuffix: true })}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={handleContinue}
            disabled={!selectedProfileId || isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : selectedProfileId === 'new' ? (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Create New
              </>
            ) : (
              'Continue'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}; 