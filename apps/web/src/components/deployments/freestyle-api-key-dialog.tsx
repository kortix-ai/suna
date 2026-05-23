'use client';

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, KeyRound, ExternalLink } from 'lucide-react';
import { useSetSecret } from '@/hooks/secrets/use-secrets';
import { deploymentKeys } from '@/hooks/deployments/use-deployments';
import { toast } from 'sonner';

interface FreestyleApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

export function FreestyleApiKeyDialog({
  open,
  onOpenChange,
  onSaved,
}: FreestyleApiKeyDialogProps) {
  const [apiKey, setApiKey] = useState('');
  const setSecret = useSetSecret();
  const queryClient = useQueryClient();

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast.error('API key cannot be empty');
      return;
    }

    try {
      await setSecret.mutateAsync({ key: 'FREESTYLE_API_KEY', value: trimmed });

      toast.success('Freestyle API key saved', {
        description: 'You can now redeploy your failed deployments or create new ones.',
      });
      setApiKey('');
      onOpenChange(false);
      onSaved?.();

      // Invalidate caches so subsequent deploy calls use the new key
      queryClient.invalidateQueries({ queryKey: deploymentKeys.all });
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
      queryClient.invalidateQueries({ queryKey: ['providers'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save API key');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="freestyle-key-description">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Configure Freestyle API Key
          </DialogTitle>
          <DialogDescription id="freestyle-key-description">
            A Freestyle API key is required to deploy applications to production.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              API Key <span className="text-destructive">*</span>
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="fs_..."
              className="font-mono"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !setSecret.isPending) handleSave();
              }}
            />
          </div>

          <a
            href="https://freestyle.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Get your API key from freestyle.sh
          </a>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={setSecret.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={setSecret.isPending || !apiKey.trim()}>
            {setSecret.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Key'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
