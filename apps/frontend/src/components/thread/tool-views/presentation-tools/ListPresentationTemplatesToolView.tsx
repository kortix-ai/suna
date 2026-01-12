import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Palette } from "lucide-react"
import { ToolViewIconTitle } from "../shared/ToolViewIconTitle"
import type { ToolViewProps } from "../types"
import { getToolTitle, formatTimestamp } from "../utils"
import { LoadingState } from "../shared/LoadingState"
import { PresentationStarter } from "@/components/thread/presentation-starter"

export function ListPresentationTemplatesToolView({
  toolCall,
  toolResult,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name)

  // Handle template/method selection - for now just log, 
  // as this is a read-only tool view showing templates
  const handleSelectMethod = (method: 'prompt' | 'pdf' | 'link', template?: string, data?: { url?: string; file?: File }) => {
    console.log('[ListPresentationTemplatesToolView] Method selected:', method, 'Template:', template, 'Data:', data)
  }

  const handleSelectTemplate = (templateId: string) => {
    console.log('[ListPresentationTemplatesToolView] Template selected:', templateId)
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Palette} title={toolTitle} />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Palette}
            iconColor="text-orange-500 dark:text-orange-400"
            bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
            title="Loading presentation templates"
            filePath="Fetching available templates..."
            showProgress={true}
          />
        ) : (
          <PresentationStarter
            onSelectMethod={handleSelectMethod}
            onSelectTemplate={handleSelectTemplate}
            className="h-full border-0 rounded-none"
          />
        )}
      </CardContent>

      <div className="px-4 py-2 h-9 bg-zinc-50/30 dark:bg-zinc-900/30 border-t border-zinc-200/30 dark:border-zinc-800/30 flex justify-between items-center">
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          <span className="font-mono">Presentation Templates</span>
        </div>
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {formatTimestamp(toolTimestamp)}
        </div>
      </div>
    </Card>
  )
}
