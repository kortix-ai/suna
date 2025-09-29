'use client';

import React, { useState, useMemo } from 'react';
import { Globe } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchBar } from './search-bar';
import { EmptyState } from '../empty-state';
import { AgentsGrid } from '../agents-grid';
import { LoadingState } from '../loading-state';
import { Pagination } from '../pagination';
import { UnifiedAgentCard } from '@/components/ui/unified-agent-card';

type AgentFilter = 'all' | 'templates';

interface MyAgentsTabProps {
  agentsSearchQuery: string;
  setAgentsSearchQuery: (value: string) => void;
  agentsLoading: boolean;
  agents: any[];
  agentsPagination: any;
  viewMode: 'grid' | 'list';
  onCreateAgent: () => void;
  onEditAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onToggleDefault: (agentId: string, currentDefault: boolean) => void;
  onClearFilters: () => void;
  deleteAgentMutation?: any;
  isDeletingAgent?: (agentId: string) => boolean;
  setAgentsPage: (page: number) => void;
  agentsPageSize: number;
  onAgentsPageSizeChange: (pageSize: number) => void;

  myTemplates: any[];
  templatesLoading: boolean;
  templatesError: any;
  templatesActioningId: string | null;
  templatesPagination?: {
    current_page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
  templatesPage: number;
  setTemplatesPage: (page: number) => void;
  templatesPageSize: number;
  onTemplatesPageSizeChange: (pageSize: number) => void;
  templatesSearchQuery: string;
  setTemplatesSearchQuery: (value: string) => void;
  onPublish: (template: any) => void;
  onUnpublish: (templateId: string, templateName: string) => void;
  getTemplateStyling: (template: any) => { color: string };

  onPublishAgent?: (agent: any) => void;
  publishingAgentId?: string | null;
}

const filterOptions = [
  { value: 'all', label: 'All Agents' },
  { value: 'templates', label: 'Templates' },
];

export const MyAgentsTab = ({
  agentsSearchQuery,
  setAgentsSearchQuery,
  agentsLoading,
  agents,
  agentsPagination,
  viewMode,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  onToggleDefault,
  onClearFilters,
  deleteAgentMutation,
  isDeletingAgent,
  setAgentsPage,
  agentsPageSize,
  onAgentsPageSizeChange,
  myTemplates,
  templatesLoading,
  templatesError,
  templatesActioningId,
  templatesPagination,
  templatesPage,
  setTemplatesPage,
  templatesPageSize,
  onTemplatesPageSizeChange,
  templatesSearchQuery,
  setTemplatesSearchQuery,
  onPublish,
  onUnpublish,
  getTemplateStyling,
  onPublishAgent,
  publishingAgentId
}: MyAgentsTabProps) => {
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');

  const templateAgentsCount = useMemo(() => {
    return myTemplates?.length || 0;
  }, [myTemplates]);

  const handleClearFilters = () => {
    setAgentFilter('all');
    onClearFilters();
  };

  const renderTemplates = () => {
    return (
      <>
        {templatesLoading ? (
          <LoadingState viewMode={viewMode} />
        ) : templatesError ? (
          <div className="text-center py-16">
            <p className="text-destructive">Failed to load templates</p>
          </div>
        ) : !myTemplates || myTemplates.length === 0 ? (
          <div className="text-center py-16">
            <div className="mx-auto w-20 h-20 bg-gradient-to-br from-primary/20 to-primary/10 rounded-3xl flex items-center justify-center mb-6">
              <Globe className="h-10 w-10 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-3">No published templates yet</h3>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto">
              Publish your agents to the marketplace to share them with the community and track their usage.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {myTemplates.map((template) => {
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
                      onSecondaryAction: template.is_public ? () => {} : undefined,
                    }}
                  />
                );
              })}
            </div>
            {templatesPagination && (
              <Pagination
                currentPage={templatesPagination.current_page}
                totalPages={templatesPagination.total_pages}
                totalItems={templatesPagination.total_items}
                pageSize={templatesPageSize}
                onPageChange={setTemplatesPage}
                onPageSizeChange={onTemplatesPageSizeChange}
                isLoading={templatesLoading}
                showPageSizeSelector={true}
                showJumpToPage={true}
                showResultsInfo={true}
              />
            )}
          </>
        )}
      </>
    );
  };

  return (
    <div className="space-y-6 mt-8 flex flex-col min-h-full">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-6">
        <SearchBar
          placeholder="Search agents..."
          value={agentsSearchQuery}
          onChange={setAgentsSearchQuery}
        />
        <div className="flex items-center gap-3">
          <Select value={agentFilter} onValueChange={(value: AgentFilter) => setAgentFilter(value)}>
            <SelectTrigger className="w-[180px] h-12 rounded-xl">
              <SelectValue placeholder="Filter agents" />
            </SelectTrigger>
            <SelectContent className='rounded-xl'>
              {filterOptions.map((filter) => (
                <SelectItem key={filter.value} className='rounded-xl' value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex-1">
        {agentFilter === 'templates' ? (
          renderTemplates()
        ) : (
          <>
            {agentsLoading ? (
              <LoadingState viewMode={viewMode} />
            ) : agents.length === 0 ? (
              <EmptyState
                hasAgents={(agentsPagination?.total_items || 0) > 0}
                onCreateAgent={onCreateAgent}
                onClearFilters={handleClearFilters}
              />
            ) : (
              <AgentsGrid
                agents={agents}
                onEditAgent={onEditAgent}
                onDeleteAgent={onDeleteAgent}
                onToggleDefault={onToggleDefault}
                deleteAgentMutation={deleteAgentMutation}
                isDeletingAgent={isDeletingAgent}
                onPublish={onPublishAgent}
                publishingId={publishingAgentId}
              />
            )}
            
            {agentsPagination && (
              <Pagination
                currentPage={agentsPagination.current_page}
                totalPages={agentsPagination.total_pages}
                totalItems={agentsPagination.total_items}
                pageSize={agentsPageSize}
                onPageChange={setAgentsPage}
                onPageSizeChange={onAgentsPageSizeChange}
                isLoading={agentsLoading}
                showPageSizeSelector={true}
                showJumpToPage={true}
                showResultsInfo={true}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}; 