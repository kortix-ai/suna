import React, { useState } from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  Package,
  Tag,
  Globe,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Link2,
  Zap,
  Filter
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { extractSearchMcpServersData } from './_utils';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';

export function SearchMcpServersForAgentToolView({
  name = 'search-mcp-servers-for-agent',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const [isResultsExpanded, setIsResultsExpanded] = useState(true);

  const {
    search_query,
    toolkits,
    total_found,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractSearchMcpServersData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
              <Search className="w-5 h-5 text-orange-500 dark:text-orange-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={cn(
                "text-xs font-medium",
                actualIsSuccess
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {actualIsSuccess ? 'Search completed' : 'Search failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Search}
            iconColor="text-orange-500 dark:text-orange-400"
            bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
            title="Searching MCP servers"
            filePath={search_query ? `"${search_query}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && search_query ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-muted/50 border flex items-center justify-center overflow-hidden">
                      <Search className="w-6 h-6 text-orange-600 dark:text-orange-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        Search Results
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        Query: "{search_query}"
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      <Filter className="w-3 h-3 mr-1" />
                      {search_query}
                    </Badge>
                    <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800">
                      <Package className="w-3 h-3 mr-1" />
                      {total_found} found
                    </Badge>
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Search className="w-4 h-4" />
                      Search Details
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Query: {search_query}</div>
                      <div>Results: {total_found}</div>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Package className="w-4 h-4" />
                      Available Services
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>MCP Servers: {toolkits?.length || 0}</div>
                      <div>Status: Ready for setup</div>
                    </div>
                  </div>
                </div>
              </div>

              {toolkits && toolkits.length > 0 && (
                <div className="border rounded-xl p-4 space-y-4">
                  <Collapsible open={isResultsExpanded} onOpenChange={setIsResultsExpanded}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" className="w-full justify-between p-0 h-auto">
                        <div className="flex items-center gap-2">
                          <Package className="w-4 h-4" />
                          <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Found MCP Servers ({total_found})
                          </h4>
                        </div>
                        {isResultsExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    
                    <CollapsibleContent className="space-y-3 mt-3">
                      <div className="grid gap-3">
                        {toolkits.map((toolkit, index) => (
                          <ToolkitCard key={index} toolkit={toolkit} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              No MCP servers found{search_query ? ` for "${search_query}"` : ''}. Try a different search term.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolkitCard({ toolkit }: { toolkit: { name: string; slug: string; description?: string; categories?: string[] } }) {
  const { data: iconData } = useComposioToolkitIcon(toolkit.slug, {
    enabled: !!toolkit.slug
  });

  return (
    <div className="bg-muted/30 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-white dark:bg-zinc-800 border flex items-center justify-center overflow-hidden">
            {iconData?.icon_url ? (
              <img
                src={iconData.icon_url}
                alt={`${toolkit.name} logo`}
                className="w-6 h-6 object-cover rounded"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent) {
                    parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-5 h-5 text-orange-600 dark:text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg></div>`;
                  }
                }}
              />
            ) : (
              <Package className="w-5 h-5 text-orange-600 dark:text-orange-400" />
            )}
          </div>
          <div>
            <h5 className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
              {toolkit.name}
            </h5>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {toolkit.slug}
            </p>
          </div>
        </div>
        
        <Badge variant="outline" className="text-xs">
          <Zap className="w-3 h-3 mr-1" />
          MCP
        </Badge>
      </div>
      
      {toolkit.description && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
          {toolkit.description}
        </p>
      )}
      
      {toolkit.categories && toolkit.categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolkit.categories.slice(0, 3).map((category) => (
            <Badge key={category} variant="secondary" className="text-xs">
              <Tag className="w-3 h-3 mr-1" />
              {category}
            </Badge>
          ))}
          {toolkit.categories.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{toolkit.categories.length - 3}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
} 