import { Button } from "@/components/ui/button";
import { X, Package, Info } from "lucide-react"; // Added Info icon

// Define the structure for tool call data based on page.tsx state
interface ToolCallData {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
}

interface ToolCallSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  toolCallData: ToolCallData | null; 
  // Add other props later if needed, e.g., history of tool calls
}

export function ToolCallSidePanel({ isOpen, onClose, toolCallData }: ToolCallSidePanelProps) {
  // Updated styling for full-height panel that sits alongside the header
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
            {toolCallData ? (
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Tool Name:</h3>
                  <p className="text-sm font-mono bg-muted p-2 rounded break-all">{toolCallData.name || 'N/A'}</p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Arguments:</h3>
                  <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                    {toolCallData.arguments 
                      ? (() => {
                          try {
                            // Attempt to parse and pretty-print JSON arguments
                            return JSON.stringify(JSON.parse(toolCallData.arguments), null, 2);
                          } catch (e) {
                            // Fallback for non-JSON arguments
                            return toolCallData.arguments;
                          }
                        })()
                      : 'No arguments'}
                  </pre>
                </div>
                {/* Placeholder for future details */}
                {/* 
                <div>
                  <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Status:</h3>
                  <p className="text-sm">Running / Completed / Error</p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Result:</h3>
                  <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">Tool output...</pre>
                </div> 
                */}
              </div>
            ) : (
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