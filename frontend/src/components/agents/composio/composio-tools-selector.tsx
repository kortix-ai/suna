import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Search, Save, AlertCircle, Loader2, Filter, X, ChevronDown } from 'lucide-react';
import { backendApi } from '@/lib/api-client';
import { useComposioTools } from '@/hooks/react-query/composio/use-composio';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { ComposioTool } from '@/hooks/react-query/composio/utils';

interface ComposioToolsSelectorProps {
  profileId?: string;
  agentId?: string;
  toolkitName: string;
  toolkitSlug: string;
  selectedTools: string[];
  onToolsChange: (tools: string[]) => void;
  onSave?: () => Promise<void>;
  onCancel?: () => void;
  showSaveButton?: boolean;
  className?: string;
  searchPlaceholder?: string;
}

const ToolCard = ({ tool, isSelected, onToggle, searchTerm }: {
  tool: ComposioTool;
  isSelected: boolean;
  onToggle: () => void;
  searchTerm: string;
}) => {
  const highlightText = (text: string, term: string) => {
    if (!term) return text;
    const regex = new RegExp(`(${term})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-900/50">{part}</mark> : part
    );
  };

  return (
    <Card className={cn(
      "group cursor-pointer transition-all p-0 shadow-none bg-card hover:bg-muted/50",
      isSelected && "bg-primary/10 ring-1 ring-primary/20"
    )}>
      <CardContent className="p-4" onClick={onToggle}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-medium text-sm truncate">
                {highlightText(tool.name, searchTerm)}
              </h3>
              {tool.tags?.includes('important') && (
                <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                  Important
                </Badge>
              )}
            </div>

            <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
              {highlightText(tool.description || 'No description available', searchTerm)}
            </p>

            <div className="flex items-center gap-2 flex-wrap">
              {tool.input_parameters?.properties && (
                <Badge variant="outline" className="text-xs">
                  {Object.keys(tool.input_parameters.properties).length} params
                </Badge>
              )}
              {tool.tags?.filter(tag => tag !== 'important').slice(0, 2).map(tag => (
                <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex-shrink-0 ml-2">
            <Checkbox
              checked={isSelected}
              onCheckedChange={onToggle}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const ToolSkeleton = () => (
  <Card className="shadow-none p-0 bg-muted/30">
    <CardContent className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="h-6 w-11 rounded-full flex-shrink-0" />
      </div>
    </CardContent>
  </Card>
);

export const ComposioToolsSelector: React.FC<ComposioToolsSelectorProps> = ({
  profileId,
  agentId,
  toolkitName,
  toolkitSlug,
  selectedTools,
  onToolsChange,
  onSave,
  onCancel,
  showSaveButton = true,
  className,
  searchPlaceholder = "Search tools..."
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [selectedTagFilters, setSelectedTagFilters] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const { data: toolsResponse, isLoading, error } = useComposioTools(toolkitSlug, { enabled: !!toolkitSlug });

  // DEDUPE: Remove duplicate tools by name, prioritizing ones with "important" tag
  const availableTools = useMemo(() => {
    const rawTools = toolsResponse?.tools || [];
    const toolMap = new Map();

    // First pass: add all tools
    rawTools.forEach(tool => {
      const existing = toolMap.get(tool.name);
      if (!existing) {
        toolMap.set(tool.name, tool);
      } else {
        // If we have a duplicate, prefer the one with "important" tag
        const hasImportant = tool.tags?.includes('important');
        const existingHasImportant = existing.tags?.includes('important');

        if (hasImportant && !existingHasImportant) {
          toolMap.set(tool.name, tool);
        }
      }
    });

    return Array.from(toolMap.values());
  }, [toolsResponse?.tools]);

  const loadCurrentAgentTools = async () => {
    if (!agentId || !profileId) {
      return;
    }

    try {
      const response = await backendApi.get(`/agents/${agentId}`);

      if (response.success && response.data) {
        const agent = response.data;
        const composioMcps = agent.custom_mcps?.filter((mcp: any) =>
          mcp.type === 'composio' && mcp.config?.profile_id === profileId
        ) || [];

        const enabledTools = composioMcps.flatMap((mcp: any) => mcp.enabledTools || []);

        // If no existing tools found, auto-select important tools
        if (enabledTools.length === 0 && availableTools.length > 0) {
          const importantTools = availableTools.filter(tool => tool.tags?.includes('important'));
          const importantToolSlugs = importantTools.map(tool => tool.slug);

          if (importantToolSlugs.length > 0) {
            onToolsChange(importantToolSlugs);
          } else {
            onToolsChange([]);
          }
        } else {
          onToolsChange(enabledTools);
        }

        initializedRef.current = true;
      }
    } catch (err) {
      console.error('Failed to load current agent tools:', err);
      // If API call fails, fall back to important tools
      if (availableTools.length > 0) {
        const importantTools = availableTools.filter(tool => tool.tags?.includes('important'));
        const importantToolSlugs = importantTools.map(tool => tool.slug);
        if (importantToolSlugs.length > 0) {
          onToolsChange(importantToolSlugs);
        } else {
          onToolsChange([]);
        }
      }
      initializedRef.current = true;
    }
  };

  // INSTANT: Show important tools as selected the moment they appear
  const getEffectiveSelectedTools = useMemo(() => {
    // Always use explicit selections if they exist
    if (selectedTools.length > 0) {
      return selectedTools;
    }

    // Only auto-select important tools for NEW agents (no agentId) when no tools are selected
    if (!agentId && availableTools.length > 0) {
      const importantTools = availableTools.filter(tool => tool.tags?.includes('important'));
      const importantToolSlugs = importantTools.map(tool => tool.slug);

      return importantToolSlugs;
    }

    // For existing agents, return empty if no tools are explicitly selected
    // (they should be loaded via loadCurrentAgentTools)
    return selectedTools;
  }, [selectedTools, availableTools, agentId]);

  // Get all unique tags
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    availableTools.forEach(tool => {
      tool.tags?.forEach(tag => tags.add(tag));
    });
    return Array.from(tags).sort((a, b) => {
      // Put "important" first, then alphabetical
      if (a === 'important') return -1;
      if (b === 'important') return 1;
      return a.localeCompare(b);
    });
  }, [availableTools]);

  // Sync the effective selection back to parent when tools load
  useEffect(() => {
    if (!initializedRef.current && availableTools.length > 0) {
      initializedRef.current = true;

      if (agentId && profileId) {
        // For existing agents, load their tools
        loadCurrentAgentTools();
      } else if (selectedTools.length === 0) {
        // For new agents, sync the important tools selection
        const importantToolSlugs = availableTools
          .filter(tool => tool.tags?.includes('important'))
          .map(tool => tool.slug);

        if (importantToolSlugs.length > 0) {
          onToolsChange(importantToolSlugs);
        }
      }
    }
  }, [availableTools, agentId, profileId]); // Added agentId and profileId as dependencies

  // Filter tools based on selected tag filters and search
  const filteredTools = useMemo(() => {
    let tools = availableTools;

    // Filter by tags if any are selected
    if (selectedTagFilters.size > 0) {
      tools = tools.filter(tool =>
        tool.tags?.some(tag => selectedTagFilters.has(tag)) ||
        (selectedTagFilters.has('untagged') && (!tool.tags || tool.tags.length === 0))
      );
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      tools = tools.filter(tool =>
        tool.name.toLowerCase().includes(term) ||
        tool.description.toLowerCase().includes(term)
      );
    }

    return tools;
  }, [availableTools, selectedTagFilters, searchTerm]);

  const handleToolToggle = (toolSlug: string) => {
    const effectiveSelected = getEffectiveSelectedTools;
    const newTools = effectiveSelected.includes(toolSlug)
      ? effectiveSelected.filter(t => t !== toolSlug)
      : [...effectiveSelected, toolSlug];
    onToolsChange(newTools);
  };

  const handleSelectAll = () => {
    const allToolSlugs = filteredTools.map(tool => tool.slug);
    onToolsChange(allToolSlugs);
  };

  const handleSelectNone = () => {
    onToolsChange([]);
  };

  const handleTagFilterToggle = (tag: string) => {
    const newFilters = new Set(selectedTagFilters);

    if (newFilters.has(tag)) {
      // Remove tag filter - just affects visibility
      newFilters.delete(tag);
    } else {
      // Add tag filter - just affects visibility
      newFilters.add(tag);
    }

    setSelectedTagFilters(newFilters);
  };

  const handleSave = async () => {
    if (!agentId || !onSave) return;

    try {
      setIsSaving(true);
      await onSave();
    } catch (error: any) {
      console.error('Failed to save tools:', error);
      toast.error(error.response?.data?.detail || 'Failed to save tools');
    } finally {
      setIsSaving(false);
    }
  };

  const selectedCount = selectedTools.length;
  const totalTools = availableTools.length;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Search and Controls Bar */}
      <div className="px-6 py-3 border-b bg-muted/20 flex-shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={searchPlaceholder}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 h-9 bg-background border-0 focus-visible:ring-1"
            />
          </div>

          {/* Tag Filter Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-9 gap-2 shadow-none",
                  selectedTagFilters.size > 0 && "border-primary/50 bg-primary/5"
                )}
              >
                <Filter className="h-4 w-4" />
                <span>Filter
                  <span className="text-muted-foreground"> ({selectedTagFilters.size || 0})</span>
                </span>

                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-80"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Filter by tags</span>
                {selectedTagFilters.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedTagFilters(new Set())}
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="max-h-56 overflow-y-auto">
                {allTags.map(tag => {
                  const isSelected = selectedTagFilters.has(tag);
                  const toolsWithTag = availableTools.filter(tool => tool.tags?.includes(tag));

                  return (
                    <DropdownMenuItem
                      key={tag}
                      className="flex items-center space-x-3 cursor-pointer focus:bg-accent"
                      onClick={(e) => {
                        e.preventDefault();
                        handleTagFilterToggle(tag);
                      }}
                      onSelect={(e) => {
                        e.preventDefault();
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        onChange={() => handleTagFilterToggle(tag)}
                        className="pointer-events-none"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={cn(
                            "text-sm font-medium truncate",
                            tag === 'important' && "text-orange-600"
                          )}>
                            {tag}
                          </span>
                          <Badge variant="outline" className="text-xs ml-2 shrink-0">
                            {toolsWithTag.length}
                          </Badge>
                        </div>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

        </div>

        {/* Compact Filter + Quick Actions */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground whitespace-nowrap text-sm">
            Showing {filteredTools.length} of {availableTools.length} tools
          </span>

          <div className='flex items-center gap-2'>
            <div className="h-4 w-px bg-border" />

            {/* Quick Actions */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSelectAll}
              disabled={isLoading || filteredTools.length === 0}
              className="h-8 text-xs"
            >
              Select All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSelectNone}
              disabled={isLoading}
              className="h-8 text-xs"
            >
              Clear
            </Button>
          </div>
        </div>

      </div>

      {/* Tools List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-6">
          {error && (
            <Alert className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error.message || 'Failed to load tools'}</AlertDescription>
            </Alert>
          )}

          {isLoading ? (
            <div className="grid gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <ToolSkeleton key={i} />
              ))}
            </div>
          ) : filteredTools.length > 0 ? (
            <div className="grid gap-3">
              {filteredTools.map((tool) => (
                <ToolCard
                  key={tool.slug}
                  tool={tool}
                  isSelected={getEffectiveSelectedTools.includes(tool.slug)}
                  onToggle={() => handleToolToggle(tool.slug)}
                  searchTerm={searchTerm}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground mb-2">
                {searchTerm
                  ? `No tools found matching "${searchTerm}"`
                  : selectedTagFilters.size > 0
                    ? 'No tools match the selected filters'
                    : 'No tools available'
                }
              </p>
              {selectedTagFilters.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedTagFilters(new Set())}
                  className="mt-2"
                >
                  Clear all filters
                </Button>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer with Save Button */}
      {showSaveButton && (
        <div className="p-6 pt-4 border-t bg-muted/20 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {getEffectiveSelectedTools.length > 0 ? (
                `${getEffectiveSelectedTools.length} tool${getEffectiveSelectedTools.length === 1 ? '' : 's'} will be added to your agent`
              ) : (
                'No tools selected'
              )}
            </div>
            <div className="flex gap-3">
              {onCancel && (
                <Button
                  variant="outline"
                  onClick={onCancel}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={isSaving || isLoading}
                className="min-w-[80px]"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save Tools
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
