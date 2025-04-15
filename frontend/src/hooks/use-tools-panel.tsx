'use client';

import { useEffect, useState, useContext } from 'react';
import { ToolCallsContext } from '@/app/providers';
import { ParsedTag, ToolDisplayMode } from '@/lib/types/tool-calls';
import { Grid3X3 } from 'lucide-react';
import { getComponentForTag } from '@/components/thread/tool-components';

export function useToolsPanel() {
  const { toolCalls, setToolCalls } = useContext(ToolCallsContext);
  const [showPanel, setShowPanel] = useState(false);
  const [currentToolIndex, setCurrentToolIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'single' | 'grid'>('single');

  // Update panel visibility when tool calls change
  useEffect(() => {
    if (toolCalls.length > 0 && !showPanel) {
      setShowPanel(true);
    }
  }, [toolCalls, showPanel]);

  // Reset current tool index when tools change
  useEffect(() => {
    if (toolCalls.length > 0) {
      console.log(`[TOOLS PANEL] Has ${toolCalls.length} tools to display:`, 
        toolCalls.map(t => `${t.tagName}${t.isClosing ? '(completed)' : '(running)'}`).join(', '));
      setCurrentToolIndex(state => Math.min(state, toolCalls.length - 1));
    } else {
      setCurrentToolIndex(0);
    }
  }, [toolCalls]);

  // Clear all tool calls
  const clearToolCalls = () => {
    setToolCalls([]);
    setShowPanel(false);
  };

  // Navigate to next tool
  const nextTool = () => {
    if (toolCalls.length > 0) {
      setCurrentToolIndex((currentToolIndex + 1) % toolCalls.length);
    }
  };

  // Navigate to previous tool
  const prevTool = () => {
    if (toolCalls.length > 0) {
      setCurrentToolIndex((currentToolIndex - 1 + toolCalls.length) % toolCalls.length);
    }
  };

  // Toggle view mode between single and grid
  const toggleViewMode = () => {
    setViewMode(viewMode === 'single' ? 'grid' : 'single');
  };

  // Navigate to next/previous tool with keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode === 'single' && toolCalls.length > 1) {
        if (e.key === 'ArrowRight') {
          nextTool();
        } else if (e.key === 'ArrowLeft') {
          prevTool();
        }
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, toolCalls.length, nextTool, prevTool]);

  // Render the tools panel content
  const renderToolsPanel = () => {
    if (!toolCalls || toolCalls.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-foreground/40">
          <p className="text-sm">No tool calls yet</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        {/* Panel header */}
        <div className="flex justify-between items-center border-b border-subtle p-3">
          <h3 className="text-sm font-medium">Tools ({toolCalls.length})</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleViewMode}
              className="p-1 rounded hover:bg-background-hover"
              title={viewMode === 'single' ? "Grid view" : "Single view"}
            >
              <Grid3X3 className="h-4 w-4 text-foreground/60" />
            </button>
          </div>
        </div>

        {/* Panel content */}
        <div className="flex-grow overflow-y-auto p-3">
          {viewMode === 'single' ? (
            <>
              {/* Single tool view */}
              {toolCalls.length > 0 && (
                <div className="h-full flex flex-col">
                  {renderToolComponent(toolCalls[currentToolIndex], 'detailed')}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Grid view */}
              <div className="grid grid-cols-1 gap-4">
                {toolCalls.map((tool, index) => (
                  <div 
                    key={tool.id || index} 
                    className={`cursor-pointer transition-all border rounded-md p-2 ${
                      index === currentToolIndex 
                        ? 'border-primary shadow-sm' 
                        : 'border-subtle hover:border-primary/40'
                    }`}
                    onClick={() => {
                      setCurrentToolIndex(index);
                      setViewMode('single');
                    }}
                  >
                    {renderToolComponent(tool, 'compact')}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Gallery navigation controls (only in single view with multiple tools) */}
        {viewMode === 'single' && toolCalls.length > 1 && (
          <div className="border-t border-subtle p-3">
            <div className="flex flex-col gap-2">
              <div className="text-xs text-muted-foreground text-center">
                Tool {currentToolIndex + 1} of {toolCalls.length}
              </div>
              <input
                type="range"
                min={0}
                max={toolCalls.length - 1}
                value={currentToolIndex}
                onChange={(e) => setCurrentToolIndex(parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render a tool component based on the tool type
  const renderToolComponent = (tag: ParsedTag, mode: ToolDisplayMode) => {
    // Get the specialized component from the registry
    const ToolComponent = getComponentForTag(tag);
    return <ToolComponent tag={tag} mode={mode} />;
  };

  return {
    toolCalls,
    setToolCalls,
    showPanel,
    setShowPanel,
    renderToolsPanel,
    clearToolCalls,
    currentToolIndex,
    setCurrentToolIndex,
    nextTool,
    prevTool,
  };
}
