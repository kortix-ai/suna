'use client';

import React from 'react';
import { useToolsPanel } from '@/hooks/use-tools-panel';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronLeft, ChevronRight, Grid3X3, Maximize2, Minimize2, PanelRightClose, Terminal, FileText, Search, Globe, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getComponentForTag } from '@/components/thread/tool-components';
import { ParsedTag } from '@/lib/types/tool-calls';
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from '@/components/ui/badge';

interface ToolCallsSidebarProps {
  className?: string;
}

interface CombinedToolCall {
  toolCall: ParsedTag;  // From assistant message
  toolResult: ParsedTag | null;  // From tool message
  id: string;
  timestamp: number;
}

const ToolIcon = ({ type }: { type: string }) => {
  if (type.includes('file')) return <FileText className="h-3.5 w-3.5" />;
  if (type.includes('command')) return <Terminal className="h-3.5 w-3.5" />;
  if (type.includes('search')) return <Search className="h-3.5 w-3.5" />;
  if (type.includes('browser')) return <Globe className="h-3.5 w-3.5" />;
  return <Terminal className="h-3.5 w-3.5" />;
};

const ToolStatus = ({ status }: { status: string }) => {
  return (
    <Badge variant={status === 'completed' ? 'default' : status === 'running' ? 'secondary' : 'destructive'} className="h-5">
      {status === 'running' && (
        <div className="mr-1 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      )}
      {status === 'completed' ? 'Done' : status === 'running' ? 'Running' : 'Failed'}
    </Badge>
  );
};

export function ToolCallsSidebar({ className }: ToolCallsSidebarProps) {
  const {
    toolCalls,
    showPanel,
    setShowPanel,
    currentToolIndex,
    setCurrentToolIndex,
    nextTool,
    prevTool,
  } = useToolsPanel();

  const [isExpanded, setIsExpanded] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<'single' | 'grid'>('single');

  // Combine tool calls with their results
  const combinedToolCalls = React.useMemo(() => {
    const combined: CombinedToolCall[] = [];
    const processedIds = new Set<string>();

    toolCalls.forEach((tag, index) => {
      // Skip if we've already processed this tag
      if (processedIds.has(tag.id)) return;

      // Look for matching result in subsequent tags
      // A result is a tag with the same name in a tool message
      const nextTags = toolCalls.slice(index + 1);
      const matchingResult = nextTags.find(nextTag => 
        nextTag.tagName === tag.tagName && 
        !processedIds.has(nextTag.id) &&
        // Match attributes if they exist
        (!tag.attributes || Object.entries(tag.attributes).every(([key, value]) => 
          nextTag.attributes?.[key] === value
        ))
      );

      if (matchingResult) {
        processedIds.add(matchingResult.id);
      }

      combined.push({
        toolCall: tag,
        toolResult: matchingResult || null,
        id: tag.id,
        timestamp: tag.timestamp || Date.now()
      });

      processedIds.add(tag.id);
    });

    return combined;
  }, [toolCalls]);

  // No need to render if there are no tool calls
  if (combinedToolCalls.length === 0) {
    return null;
  }

  const toggleViewMode = () => {
    setViewMode(viewMode === 'single' ? 'grid' : 'single');
  };

  const renderToolCall = (combined: CombinedToolCall, mode: 'compact' | 'detailed') => {
    const { toolCall, toolResult } = combined;
    const isCompleted = !!toolResult;

    if (mode === 'compact') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ToolIcon type={toolCall.tagName} />
            <span className="text-sm font-medium">{toolCall.tagName}</span>
            <div className="flex-1" />
            <ToolStatus status={isCompleted ? 'completed' : 'running'} />
          </div>
          <div className="text-xs text-muted-foreground line-clamp-2">
            {toolCall.content}
          </div>
          {toolResult && (
            <>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3" />
                <span>Result</span>
              </div>
              <div className="text-xs text-muted-foreground line-clamp-2">
                {toolResult.content}
              </div>
            </>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-lg border bg-card text-card-foreground">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-2">
              <ToolIcon type={toolCall.tagName} />
              <span className="text-sm font-medium">{toolCall.tagName}</span>
            </div>
            <ToolStatus status={isCompleted ? 'completed' : 'running'} />
          </div>
          <div className="p-4 text-sm font-mono">
            {toolCall.content}
          </div>
        </div>

        {toolResult && (
          <div className="rounded-lg border bg-card text-card-foreground">
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <ArrowRight className="h-3.5 w-3.5" />
              <span className="text-sm font-medium">Result</span>
            </div>
            <div className="p-4 text-sm font-mono">
              {toolResult.content}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <AnimatePresence>
      {showPanel && (
        <motion.aside 
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className={cn(
            "fixed right-0 top-0 z-30 flex h-screen flex-col border-l bg-background/80 backdrop-blur-md",
            isExpanded ? "w-[600px]" : "w-[400px]",
            className
          )}
        >
          {/* Toggle button */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute -left-10 top-4 h-8 w-8 rounded-l-md border-y border-l bg-background/80 backdrop-blur-md shadow-sm hover:bg-background/90 transition-colors"
            onClick={() => setShowPanel(!showPanel)}
          >
            <PanelRightClose className={cn(
              "h-4 w-4 transition-transform duration-200",
              !showPanel && "rotate-180"
            )} />
          </Button>

          {/* Header */}
          <div className="flex items-center justify-between border-b bg-background/50 px-4 py-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium">Tool Calls</h3>
              <Badge variant="outline" className="h-5">
                {currentToolIndex + 1}/{combinedToolCalls.length}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={toggleViewMode}
                title={viewMode === 'single' ? 'Switch to grid view' : 'Switch to single view'}
              >
                <Grid3X3 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setIsExpanded(!isExpanded)}
                title={isExpanded ? 'Collapse panel' : 'Expand panel'}
              >
                {isExpanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1">
            <div className="p-4">
              {viewMode === 'single' ? (
                <div className="space-y-4">
                  {renderToolCall(combinedToolCalls[currentToolIndex], 'detailed')}
                  
                  {/* Navigation */}
                  {combinedToolCalls.length > 1 && (
                    <div className="flex items-center gap-2 mt-6">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={prevTool}
                        disabled={currentToolIndex === 0}
                        className="flex-1"
                      >
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={nextTool}
                        disabled={currentToolIndex === combinedToolCalls.length - 1}
                        className="flex-1"
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {combinedToolCalls.map((toolCall, index) => (
                    <motion.div
                      key={toolCall.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={cn(
                        "cursor-pointer transition-all border rounded-lg p-3 hover:shadow-sm",
                        index === currentToolIndex
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/40 hover:bg-muted/40"
                      )}
                      onClick={() => {
                        setCurrentToolIndex(index);
                        setViewMode('single');
                      }}
                    >
                      {renderToolCall(toolCall, 'compact')}
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Progress bar */}
          {viewMode === 'single' && combinedToolCalls.length > 1 && (
            <div className="px-4 py-3 border-t bg-background/50">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={combinedToolCalls.length - 1}
                  value={currentToolIndex}
                  onChange={(e) => setCurrentToolIndex(parseInt(e.target.value))}
                  className="flex-1"
                />
              </div>
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
} 