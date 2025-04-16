import { Button } from "@/components/ui/button";
import { X, Package, Info, Terminal, CheckCircle, SkipBack, SkipForward } from "lucide-react";
import { Slider } from "@/components/ui/slider";

// Define the structure for LIVE tool call data (from streaming)
export interface ToolCallData {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
}

// Define the structure for HISTORICAL tool call pairs
export interface HistoricalToolPair {
  type: 'historical';
  assistantCall: { content?: string; name?: string }; // Include name from parsed content if needed
  userResult: { content?: string; name?: string };
}

// Union type for side panel content
export type SidePanelContent = ToolCallData | HistoricalToolPair;

// Type guard to check if content is a HistoricalToolPair
function isHistoricalPair(content: SidePanelContent | null): content is HistoricalToolPair {
  return !!content && (content as HistoricalToolPair).type === 'historical';
}

interface ToolCallSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  content: SidePanelContent | null;
  currentIndex: number | null;
  totalPairs: number;
  onNavigate: (newIndex: number) => void;
}

export function ToolCallSidePanel({
  isOpen,
  onClose,
  content,
  currentIndex,
  totalPairs,
  onNavigate
}: ToolCallSidePanelProps) {
  // Updated styling for full-height panel that sits alongside the header
  const showNavigation = isHistoricalPair(content) && totalPairs > 1 && currentIndex !== null;

  return (
    <div 
      className={`
        ${isOpen ? 'w-full sm:w-[85%] md:w-[75%] lg:w-[60%] xl:w-[50%] 2xl:w-[40%] max-w-[1000px]' : 'w-0'} 
        border-l bg-sidebar h-screen flex flex-col 
        transition-all duration-300 ease-in-out overflow-hidden
        fixed sm:sticky top-0 right-0 z-30 
      `}
    >
      {/* Ensure content doesn't render or is hidden when closed to prevent layout shifts */}
      {isOpen && (
        <>
          <div className="flex items-center justify-between p-4 shrink-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Info className="h-5 w-5" /> 
              Suna´s Computer
            </h2>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
              <span className="sr-only">Close Panel</span>
            </Button>
          </div>
          <div className="flex-1 p-4 overflow-y-auto">
            {/* Navigation Controls - Conditionally Rendered */} 
            {showNavigation && (
              <div className="mb-6 pb-4 border-b">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-muted-foreground">
                    Step {currentIndex + 1} of {totalPairs}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => onNavigate(currentIndex - 1)}
                      disabled={currentIndex === 0}
                      className="h-7 w-7"
                    >
                      <SkipBack className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => onNavigate(currentIndex + 1)}
                      disabled={currentIndex === totalPairs - 1}
                      className="h-7 w-7"
                    >
                      <SkipForward className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <Slider
                  value={[currentIndex]} // Slider value is an array
                  max={totalPairs - 1}
                  step={1}
                  onValueChange={(value) => onNavigate(value[0])} // onValueChange gives an array
                />
              </div>
            )}

            {content ? (
              // ---- Render Historical Pair ----
              'type' in content && content.type === 'historical' ? (
                <div className="space-y-6"> {/* Increased spacing for sections */}
                  <div>
                    <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5 text-muted-foreground">
                      <Terminal className="h-4 w-4" />
                      Tool Call (Assistant)
                    </h3>
                    <div className="space-y-2">
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Name:</h4>
                        <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.assistantCall.name || 'N/A'}</p>
                      </div>
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Content/Arguments:</h4>
                        <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                          {content.assistantCall.content || 'No content'}
                        </pre>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5 text-muted-foreground">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      Tool Result (User)
                    </h3>
                     <div className="space-y-2">
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Name:</h4>
                        <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.userResult.name || 'N/A'}</p>
                      </div>
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Content/Output:</h4>
                        <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                          {content.userResult.content || 'No content'}
                        </pre>
                      </div>
                    </div>
                  </div>
                </div>
              ) :
              // ---- Render Live Tool Call Data ----
              'name' in content ? ( // Check if it's ToolCallData
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Tool Name (Live):</h3>
                    <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.name || 'N/A'}</p>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Arguments (Live):</h3>
                    <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                      {content.arguments
                        ? (() => {
                            try {
                              // Attempt to parse and pretty-print JSON arguments
                              return JSON.stringify(JSON.parse(content.arguments || ''), null, 2);
                            } catch (e) {
                              // Fallback for non-JSON arguments
                              return content.arguments;
                            }
                          })()
                        : 'No arguments'}
                    </pre>
                  </div>
                  {/* Add optional ID/Index if needed */}
                   {content.id && (
                     <div>
                       <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Tool Call ID:</h3>
                       <p className="text-xs font-mono bg-muted p-1 rounded break-all">{content.id}</p>
                     </div>
                   )}
                </div>
              ) : null // Should not happen if content is not null, but handles edge case
            ) : (
              // ---- Render Empty State ----
              <div className="text-center text-muted-foreground text-sm mt-8 flex flex-col items-center gap-2">
                <Package className="h-10 w-10 mb-2 text-muted-foreground/50" />
                <p className="font-medium">No Tool Call Active</p>
                <p className="text-xs">Details will appear here when the agent uses a tool.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
} 