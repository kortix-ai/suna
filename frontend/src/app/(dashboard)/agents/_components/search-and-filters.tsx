import React from 'react';
import { Search, Filter, SortAsc, SortDesc, X, Settings, Wrench, Grid3X3, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';

type SortOption = 'name' | 'created_at' | 'updated_at' | 'tools_count';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'grid' | 'list';

interface FilterOptions {
  hasDefaultAgent: boolean;
  hasMcpTools: boolean;
  hasAgentpressTools: boolean;
  selectedTools: string[];
}

interface SearchAndFiltersProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortBy: SortOption;
  setSortBy: (sort: SortOption) => void;
  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
  filters: FilterOptions;
  setFilters: React.Dispatch<React.SetStateAction<FilterOptions>>;
  activeFiltersCount: number;
  clearFilters: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  allTools: string[];
}

export const SearchAndFilters = ({
  searchQuery,
  setSearchQuery,
  sortBy,
  setSortBy,
  sortOrder,
  setSortOrder,
  filters,
  setFilters,
  activeFiltersCount,
  clearFilters,
  viewMode,
  setViewMode,
  allTools
}: SearchAndFiltersProps) => {
  return (
    <div className="flex flex-col w-full gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col w-full gap-3 sm:flex-row sm:items-center flex-1">
        <div className="relative flex-1 w-full border rounded-xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
              onClick={() => setSearchQuery('')}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>

        {/* <Select value={sortBy} onValueChange={(value: SortOption) => setSortBy(value)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="created_at">Created Date</SelectItem>
            <SelectItem value="updated_at">Updated Date</SelectItem>
            <SelectItem value="tools_count">Tools Count</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
          className="px-3"
        >
          {sortOrder === 'asc' ? <SortAsc className="h-4 w-4" /> : <SortDesc className="h-4 w-4" />}
        </Button> */}
      </div>

      <div className="flex items-center gap-2">
        {/* <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="relative">
              <Filter className="h-4 w-4" />
              Filter
              {activeFiltersCount > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 w-5 rounded-full p-0 text-xs">
                  {activeFiltersCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Filter by</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={filters.hasMcpTools}
              onCheckedChange={(checked) => 
                setFilters(prev => ({ ...prev, hasMcpTools: checked }))
              }
            >
              <Wrench className="h-4 w-4" />
              Has MCP tools
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filters.hasAgentpressTools}
              onCheckedChange={(checked) => 
                setFilters(prev => ({ ...prev, hasAgentpressTools: checked }))
              }
            >
              <Settings className="h-4 w-4" />
              Has Default tools
            </DropdownMenuCheckboxItem>
            {activeFiltersCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={clearFilters}>
                  <X className="h-4 w-4" />
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu> */}

        {/* <div className="flex border rounded-md">
          <Button
            variant={viewMode === 'grid' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('grid')}
            className="rounded-r-none border-r"
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === 'list' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('list')}
            className="rounded-l-none"
          >
            <List className="h-4 w-4" />
          </Button>
        </div> */}
      </div>
    </div>
  );
}