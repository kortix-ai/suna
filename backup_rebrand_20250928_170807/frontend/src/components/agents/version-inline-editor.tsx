'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Edit2, Check, X, Loader2 } from 'lucide-react';
import { useUpdateVersionDetails } from '@/lib/versioning/hooks/use-versions';
import { cn } from '@/lib/utils';

interface VersionInlineEditorProps {
  agentId: string;
  versionId: string;
  versionName: string;
  changeDescription?: string;
  isActive?: boolean;
  onUpdate?: (updatedVersion: { versionName: string; changeDescription?: string }) => void;
}

export function VersionInlineEditor({
  agentId,
  versionId,
  versionName,
  changeDescription,
  isActive = false,
  onUpdate
}: VersionInlineEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(versionName);
  const [editedDescription, setEditedDescription] = useState(changeDescription || '');
  const [hasChanges, setHasChanges] = useState(false);

  const updateVersionMutation = useUpdateVersionDetails();

  useEffect(() => {
    const nameChanged = editedName !== versionName;
    const descriptionChanged = editedDescription !== (changeDescription || '');
    setHasChanges(nameChanged || descriptionChanged);
  }, [editedName, editedDescription, versionName, changeDescription]);

  const handleStartEdit = () => {
    setIsEditing(true);
    setEditedName(versionName);
    setEditedDescription(changeDescription || '');
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditedName(versionName);
    setEditedDescription(changeDescription || '');
    setHasChanges(false);
  };

  const handleSave = async () => {
    if (!hasChanges) {
      setIsEditing(false);
      return;
    }

    try {
      const updateData: { version_name?: string; change_description?: string } = {};
      
      if (editedName !== versionName) {
        updateData.version_name = editedName;
      }
      
      if (editedDescription !== (changeDescription || '')) {
        updateData.change_description = editedDescription;
      }

      await updateVersionMutation.mutateAsync({
        agentId,
        versionId,
        data: updateData
      });

      setIsEditing(false);
      onUpdate?.({
        versionName: editedName,
        changeDescription: editedDescription
      });
    } catch (error) {
      // Error is handled by the mutation hook
      console.error('Failed to update version:', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancel();
    } else if (e.key === 'Enter' && e.metaKey) {
      handleSave();
    }
  };

  if (isEditing) {
    return (
      <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Input
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Version name"
            className="flex-1"
            autoFocus
          />
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleSave();
              }}
              disabled={!hasChanges || updateVersionMutation.isPending}
              className="h-8 w-8 p-0"
            >
              {updateVersionMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleCancel();
              }}
              disabled={updateVersionMutation.isPending}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Textarea
          value={editedDescription}
          onChange={(e) => setEditedDescription(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Change description (optional)"
          className="min-h-[60px] resize-none"
        />
        <div className="text-xs text-muted-foreground">
          Press Escape to cancel, Cmd+Enter to save
        </div>
      </div>
    );
  }

  return (
    <div className="group space-y-1">
      <div className="flex items-center gap-2">
        <span className={cn(
          "font-medium",
          isActive && "text-primary"
        )}>
          {versionName}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            handleStartEdit();
          }}
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Edit2 className="h-3 w-3" />
        </Button>
      </div>
      {changeDescription && (
        <p className="text-sm text-muted-foreground line-clamp-2">
          {changeDescription}
        </p>
      )}
    </div>
  );
} 