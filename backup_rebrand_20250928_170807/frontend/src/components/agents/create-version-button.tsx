'use client';

import React, { useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateAgentVersion } from '@/lib/versioning';
import { toast } from 'sonner';

interface CreateVersionButtonProps {
  agentId: string;
  currentFormData: {
    system_prompt: string;
    configured_mcps: any[];
    custom_mcps: any[];
    agentpress_tools: Record<string, any>;
  };
  hasChanges: boolean;
  onVersionCreated?: () => void;
}

export function CreateVersionButton({ 
  agentId, 
  currentFormData,
  hasChanges,
  onVersionCreated 
}: CreateVersionButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [description, setDescription] = useState('');
  const createVersionMutation = useCreateAgentVersion();

  const handleCreateVersion = async () => {
    if (!versionName.trim()) {
      toast.error('Please provide a version name');
      return;
    }

    try {
      await createVersionMutation.mutateAsync({
        agentId,
        data: {
          system_prompt: currentFormData.system_prompt,
          configured_mcps: currentFormData.configured_mcps,
          custom_mcps: currentFormData.custom_mcps,
          agentpress_tools: currentFormData.agentpress_tools,
          version_name: versionName.trim(),
          description: description.trim() || undefined,
        }
      });

      setShowDialog(false);
      setVersionName('');
      setDescription('');
      
      if (onVersionCreated) {
        onVersionCreated();
      }
      
      toast.success('New version created successfully');
    } catch (error) {
      console.error('Failed to create version:', error);
      toast.error('Failed to create version');
    }
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setShowDialog(true)}
              disabled={!hasChanges}
            >
              <Save className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{hasChanges ? 'Create Version' : 'No changes to save'}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Version</DialogTitle>
            <DialogDescription>
              Save the current agent configuration as a new version. This allows you to preserve different configurations and switch between them.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="version-name">Version Name</Label>
              <Input
                id="version-name"
                placeholder="e.g., v2, Production Ready, Beta Features"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                autoFocus
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="What changes does this version include?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDialog(false)}
              disabled={createVersionMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateVersion}
              disabled={createVersionMutation.isPending}
            >
              {createVersionMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Version'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
} 