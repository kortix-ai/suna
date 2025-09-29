'use client';

import React from 'react';
import { Plus, Globe, AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UnifiedAgentCard } from '@/components/ui/unified-agent-card';

interface MyTemplatesTabProps {
  templatesError: any;
  templatesLoading: boolean;
  myTemplates: any[] | undefined;
  templatesActioningId: string | null;
  onPublish: (template: any) => void;
  onUnpublish: (templateId: string, templateName: string) => void;
  onViewInMarketplace: () => void;
  onSwitchToMyAgents: () => void;
  getTemplateStyling: (template: any) => { color: string };
}

export const MyTemplatesTab = ({
  templatesError,
  templatesLoading,
  myTemplates,
  templatesActioningId,
  onPublish,
  onUnpublish,
  onViewInMarketplace,
  onSwitchToMyAgents,
  getTemplateStyling
}: MyTemplatesTabProps) => {
  return (
    <div className="space-y-6 mt-8">
      {templatesError ? (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load your templates. Please try again later.
          </AlertDescription>
        </Alert>
      ) : templatesLoading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-card rounded-2xl overflow-hidden shadow-sm">
              <Skeleton className="h-48" />
              <div className="p-6 space-y-3">
                <Skeleton className="h-5 rounded" />
                <Skeleton className="h-4 rounded w-3/4" />
                <div className="flex gap-2">
                  <Skeleton className="h-10 rounded-full flex-1" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : myTemplates?.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto w-20 h-20 bg-gradient-to-br from-primary/20 to-primary/10 rounded-3xl flex items-center justify-center mb-6">
            <Globe className="h-10 w-10 text-primary" />
          </div>
          <h3 className="text-xl font-semibold mb-3">No templates yet</h3>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Create your first secure agent template to share with the community while keeping your credentials safe.
          </p>
          <Button onClick={onSwitchToMyAgents} size="lg">
            <Plus className="h-4 w-4 mr-2" />
            Create Your First Agent
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {myTemplates?.map((template) => {
            const isActioning = templatesActioningId === template.template_id;
            return (
              <UnifiedAgentCard
                key={template.template_id}
                variant="template"
                data={{
                  id: template.template_id,
                  name: template.name,
                  tags: template.tags,
                  created_at: template.created_at,
                  template_id: template.template_id,
                  is_public: template.is_public,
                  download_count: template.download_count,
                  icon_name: template.icon_name,
                  icon_color: template.icon_color,
                  icon_background: template.icon_background,
                }}
                state={{
                  isActioning: isActioning,
                }}
                actions={{
                  onPrimaryAction: template.is_public 
                    ? () => onUnpublish(template.template_id, template.name)
                    : () => onPublish(template),
                  onSecondaryAction: template.is_public ? onViewInMarketplace : undefined,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}; 