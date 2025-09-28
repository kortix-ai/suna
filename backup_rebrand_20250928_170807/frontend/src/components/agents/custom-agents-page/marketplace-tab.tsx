'use client';

import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchBar } from './search-bar';
import { MarketplaceSectionHeader } from './marketplace-section-header';
import { AgentCard } from './agent-card';
import { Pagination } from '../pagination';

import type { MarketplaceTemplate } from '@/components/agents/installation/types';

interface MarketplaceTabProps {
  marketplaceSearchQuery: string;
  setMarketplaceSearchQuery: (value: string) => void;
  marketplaceFilter: 'all' | 'kortix' | 'community' | 'mine';
  setMarketplaceFilter: (value: 'all' | 'kortix' | 'community' | 'mine') => void;
  marketplaceLoading: boolean;
  allMarketplaceItems: MarketplaceTemplate[];
  mineItems: MarketplaceTemplate[];
  installingItemId: string | null;
  onInstallClick: (item: MarketplaceTemplate, e?: React.MouseEvent) => void;
  onDeleteTemplate?: (item: MarketplaceTemplate, e?: React.MouseEvent) => void;
  getItemStyling: (item: MarketplaceTemplate) => { avatar: string; color: string };
  currentUserId?: string;
  onAgentPreview?: (agent: MarketplaceTemplate) => void;
  
  marketplacePage: number;
  setMarketplacePage: (page: number) => void;
  marketplacePageSize: number;
  onMarketplacePageSizeChange: (pageSize: number) => void;
  marketplacePagination?: {
    current_page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
}

export const MarketplaceTab = ({
  marketplaceSearchQuery,
  setMarketplaceSearchQuery,
  marketplaceFilter,
  setMarketplaceFilter,
  marketplaceLoading,
  allMarketplaceItems,
  mineItems,
  installingItemId,
  onInstallClick,
  onDeleteTemplate,
  getItemStyling,
  currentUserId,
  onAgentPreview,
  marketplacePage,
  setMarketplacePage,
  marketplacePageSize,
  onMarketplacePageSizeChange,
  marketplacePagination
}: MarketplaceTabProps) => {
  const handleAgentClick = (item: MarketplaceTemplate) => {
    if (onAgentPreview) {
      onAgentPreview(item);
    }
  };

  return (
    <div className="space-y-6 mt-8 flex flex-col min-h-full">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-6">
        <SearchBar
          placeholder="Search agents..."
          value={marketplaceSearchQuery}
          onChange={setMarketplaceSearchQuery}
        />
        <div className="flex items-center gap-3">
          <Select value={marketplaceFilter} onValueChange={(value: 'all' | 'kortix' | 'community' | 'mine') => setMarketplaceFilter(value)}>
            <SelectTrigger className="w-[180px] h-12 rounded-xl">
              <SelectValue placeholder="Filter agents" />
            </SelectTrigger>
            <SelectContent className='rounded-xl'>
              <SelectItem className='rounded-xl' value="all">All Agents</SelectItem>
              <SelectItem className='rounded-xl' value="mine">Mine</SelectItem>
              <SelectItem className='rounded-xl' value="kortix">Kortix Verified</SelectItem>
              <SelectItem className='rounded-xl' value="community">Community</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1">
        {marketplaceLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-card rounded-2xl overflow-hidden shadow-sm">
                <Skeleton className="h-48" />
                <div className="p-6 space-y-3">
                  <Skeleton className="h-5 rounded" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 rounded" />
                    <Skeleton className="h-4 rounded w-3/4" />
                  </div>
                  <Skeleton className="h-10 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : allMarketplaceItems.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">
              {marketplaceSearchQuery 
                ? "No templates found matching your criteria. Try adjusting your search or filters."
                : "No agent templates are currently available in the marketplace."}
            </p>
          </div>
        ) : (
          <div className="space-y-12">
            {marketplaceFilter === 'all' ? (
              <div className="space-y-6">
                {/* <MarketplaceSectionHeader
                  title="Popular Agents"
                  subtitle="Sorted by popularity - most downloads first"
                /> */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {allMarketplaceItems.map((item) => (
                    <AgentCard
                      key={item.id}
                      mode="marketplace"
                      data={item}
                      styling={getItemStyling(item)}
                      isActioning={installingItemId === item.id}
                      onPrimaryAction={onInstallClick}
                      onDeleteAction={onDeleteTemplate}
                      onClick={() => handleAgentClick(item)}
                      currentUserId={currentUserId}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {allMarketplaceItems.map((item) => (
                  <AgentCard
                    key={item.id}
                    mode="marketplace"
                    data={item}
                    styling={getItemStyling(item)}
                    isActioning={installingItemId === item.id}
                    onPrimaryAction={onInstallClick}
                    onDeleteAction={onDeleteTemplate}
                    onClick={() => handleAgentClick(item)}
                    currentUserId={currentUserId}
                  />
                ))}
              </div>
            )}
            {marketplacePagination && (
              <Pagination
                currentPage={marketplacePagination.current_page}
                totalPages={marketplacePagination.total_pages}
                totalItems={marketplacePagination.total_items}
                pageSize={marketplacePagination.page_size}
                onPageChange={setMarketplacePage}
                onPageSizeChange={onMarketplacePageSizeChange}
                isLoading={marketplaceLoading}
                showPageSizeSelector={true}
                showJumpToPage={true}
                showResultsInfo={true}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}; 