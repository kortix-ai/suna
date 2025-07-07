'use client';

import React, { useState } from 'react';
import { Globe, GlobeLock, Download, Calendar, User, Tags, Loader2, AlertTriangle, Plus, GitBranch, Edit2, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useMyTemplates, useUnpublishTemplate, usePublishTemplate } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { toast } from 'sonner';
import { getAgentAvatar } from '../../agents/_utils/get-agent-style';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';

interface PublishDialogData {
  templateId: string;
  templateName: string;
  currentTags: string[];
}

export default function MyTemplatesPage() {
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [publishDialog, setPublishDialog] = useState<PublishDialogData | null>(null);
  const [publishTags, setPublishTags] = useState('');
  
  const { data: templates, isLoading, error } = useMyTemplates();
  const unpublishMutation = useUnpublishTemplate();
  const publishMutation = usePublishTemplate();

  const handleUnpublish = async (templateId: string, templateName: string) => {
    try {
      setActioningId(templateId);
      await unpublishMutation.mutateAsync(templateId);
      toast.success(`${templateName} has been unpublished from the marketplace`);
    } catch (error: any) {
      toast.error(error.message || 'Failed to unpublish template');
    } finally {
      setActioningId(null);
    }
  };

  const openPublishDialog = (template: any) => {
    setPublishDialog({
      templateId: template.template_id,
      templateName: template.name,
      currentTags: template.tags || []
    });
    setPublishTags((template.tags || []).join(', '));
  };

  const handlePublish = async () => {
    if (!publishDialog) return;

    try {
      setActioningId(publishDialog.templateId);
      
      // Parse tags from comma-separated string
      const tags = publishTags
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);

      await publishMutation.mutateAsync({
        template_id: publishDialog.templateId,
        tags: tags.length > 0 ? tags : undefined
      });
      
      toast.success(`${publishDialog.templateName} has been published to the marketplace`);
      setPublishDialog(null);
      setPublishTags('');
    } catch (error: any) {
      toast.error(error.message || 'Failed to publish template');
    } finally {
      setActioningId(null);
    }
  };

  const getTemplateStyling = (template: any) => {
    if (template.avatar && template.avatar_color) {
      return {
        avatar: template.avatar,
        color: template.avatar_color,
      };
    }
    return getAgentAvatar(template.template_id);
  };

  if (error) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load your templates. Please try again later.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <>
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="space-y-8">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  My Templates
                </h1>
                <p className="text-muted-foreground">
                  Manage your secure agent templates and marketplace presence
                </p>
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-neutral-100 dark:bg-sidebar border border-border rounded-2xl overflow-hidden">
                  <Skeleton className="h-32 w-full" />
                  <div className="p-4 space-y-3">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : templates?.length === 0 ? (
            <div className="text-center py-12">
              <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                <Globe className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">No templates yet</h3>
              <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                Create your first secure agent template to share with the community while keeping your credentials safe.
              </p>
              <Link href="/agents">
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Your First Agent
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {templates?.map((template) => {
                const { avatar, color } = getTemplateStyling(template);
                const isActioning = actioningId === template.template_id;
                
                return (
                  <div 
                    key={template.template_id} 
                    className="bg-neutral-100 dark:bg-sidebar border border-border rounded-2xl overflow-hidden hover:bg-muted/50 transition-all duration-200 flex flex-col h-full"
                  >
                    <div className={`h-32 flex items-center justify-center relative`} style={{ backgroundColor: color }}>
                      <div className="text-4xl">
                        {avatar}
                      </div>
                      <div className="absolute top-2 right-2">
                        {template.is_public ? (
                          <Badge variant="default" className="bg-green-100 text-green-800 border-green-200">
                            <Globe className="h-3 w-3 mr-1" />
                            Public
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-gray-100 text-gray-700 border-gray-200">
                            <GlobeLock className="h-3 w-3 mr-1" />
                            Private
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="p-4 flex flex-col flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-foreground font-medium text-lg line-clamp-1 flex-1">
                          {template.name}
                        </h3>
                        {template.metadata?.source_version_name && (
                          <Badge variant="secondary" className="text-xs shrink-0">
                            <GitBranch className="h-3 w-3" />
                            {template.metadata.source_version_name}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground text-sm mb-3 line-clamp-2">
                        {template.description || 'No description available'}
                      </p>
                      
                      {template.tags && template.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {template.tags.slice(0, 2).map(tag => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {template.tags.length > 2 && (
                            <Badge variant="outline" className="text-xs">
                              +{template.tags.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}

                      <div className="space-y-1 mb-4">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          <span>Created {new Date(template.created_at).toLocaleDateString()}</span>
                        </div>
                        {template.is_public && template.marketplace_published_at && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Globe className="h-3 w-3" />
                            <span>Published {new Date(template.marketplace_published_at).toLocaleDateString()}</span>
                          </div>
                        )}
                        {template.is_public && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Download className="h-3 w-3" />
                            <span>{template.download_count} downloads</span>
                          </div>
                        )}
                      </div>

                      <div className="mt-auto space-y-2">
                        {template.is_public ? (
                          <>
                            <Button
                              onClick={() => handleUnpublish(template.template_id, template.name)}
                              disabled={isActioning}
                              variant="outline"
                              className="w-full"
                              size="sm"
                            >
                              {isActioning ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin mr-2" />
                                  Unpublishing...
                                </>
                              ) : (
                                <>
                                  <GlobeLock className="h-3 w-3 mr-2" />
                                  Make Private
                                </>
                              )}
                            </Button>
                            <Link href={`/marketplace?search=${encodeURIComponent(template.name)}`} className="w-full">
                              <Button variant="ghost" size="sm" className="w-full">
                                <Eye className="h-3 w-3 mr-2" />
                                View in Marketplace
                              </Button>
                            </Link>
                          </>
                        ) : (
                          <Button
                            onClick={() => openPublishDialog(template)}
                            disabled={isActioning}
                            variant="default"
                            className="w-full"
                            size="sm"
                          >
                            {isActioning ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin mr-2" />
                                Publishing...
                              </>
                            ) : (
                              <>
                                <Globe className="h-3 w-3 mr-2" />
                                Publish to Marketplace
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Publish Dialog */}
      <Dialog open={!!publishDialog} onOpenChange={() => setPublishDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish Template to Marketplace</DialogTitle>
            <DialogDescription>
              Make "{publishDialog?.templateName}" available for the community to discover and install.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="tags">Tags (optional)</Label>
              <Input
                id="tags"
                placeholder="automation, productivity, data-analysis"
                value={publishTags}
                onChange={(e) => setPublishTags(e.target.value)}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Separate tags with commas to help users discover your template
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPublishDialog(null)}
              disabled={!!actioningId}
            >
              Cancel
            </Button>
            <Button
              onClick={handlePublish}
              disabled={!!actioningId}
            >
              {actioningId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Publishing...
                </>
              ) : (
                <>
                  <Globe className="h-4 w-4 mr-2" />
                  Publish Template
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
} 