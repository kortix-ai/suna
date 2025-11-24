import { useState } from "react"
import Image from "next/image"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Palette, Sparkles, CheckCircle, Loader2, AlertTriangle, ArrowLeft, X } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ToolViewProps } from "../types"
import { getToolTitle, formatTimestamp } from "../utils"
import { LoadingState } from "../shared/LoadingState"
import { getPdfUrl, getImageUrl } from "../utils/presentation-utils"

interface Template {
  id: string
  name: string
  has_image: boolean
}

interface TemplatesData {
  message: string
  templates: Template[]
  note?: string
}


export function ListPresentationTemplatesToolView({
  toolCall,
  toolResult,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name)
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set())

  const handleTemplateClick = (templateId: string) => {
    setSelectedTemplate(templateId)
  }

  const handleBack = () => {
    setSelectedTemplate(null)
  }

  const handleImageLoad = (templateId: string) => {
    setLoadedImages(prev => new Set(prev).add(templateId))
  }

  // Extract from toolResult.output (from metadata)
  let templatesData: TemplatesData | null = null
  let error: string | null = null
  let autoOpenTemplate: string | null = null

  try {
    if (toolResult?.output) {
      let output = toolResult.output
      if (typeof output === "string") {
        try {
          templatesData = JSON.parse(output)
        } catch (e) {
          console.error("Failed to parse tool output:", e)
          error = "Failed to parse templates data"
        }
      } else {
        templatesData = output as unknown as TemplatesData
      }

      // Check if this is load_template_design (has template_name in response)
      if (templatesData && (templatesData as any).template_name) {
        autoOpenTemplate = (templatesData as any).template_name
      }
    }
  } catch (e) {
    console.error("Error processing tool result:", e)
    error = "Error processing templates data"
  }

  // Auto-open template if specified (from load_template_design)
  if (autoOpenTemplate && !selectedTemplate) {
    setSelectedTemplate(autoOpenTemplate)
  }

  const templates = templatesData?.templates || []

  // If a template is selected, show PDF viewer
  if (selectedTemplate) {
    const template = templates.find(t => t.id === selectedTemplate)
    const pdfUrl = `${getPdfUrl(selectedTemplate)}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`
    const showBackButton = !autoOpenTemplate // Only show back button if user clicked from grid, not auto-opened

    return (
      <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
          <div className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
                <Palette className="w-5 h-5 text-orange-500 dark:text-orange-400" />
              </div>
              <div>
                <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                  {template?.name.replace(/_/g, " ") || selectedTemplate.replace(/_/g, " ") || "Template Preview"}
                </CardTitle>
              </div>
            </div>
            {showBackButton && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBack}
                className="h-8 px-2"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0 h-full flex-1 overflow-hidden relative bg-muted/10">
          <object
            data={pdfUrl}
            type="application/pdf"
            className="w-full h-full border-0"
            title={`${template?.name} PDF`}
          >
            <iframe
              src={pdfUrl}
              className="w-full h-full border-0"
              title={`${template?.name} PDF`}
            />
          </object>
        </CardContent>

        <div className="px-4 py-2 h-9 bg-zinc-50/30 dark:bg-zinc-900/30 border-t border-zinc-200/30 dark:border-zinc-800/30 flex justify-between items-center">
          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            <span className="font-mono">Template Preview</span>
          </div>
          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            {formatTimestamp(toolTimestamp)}
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
              <Palette className="w-5 h-5 text-orange-500 dark:text-orange-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStreaming && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Success
              </Badge>
            )}

            {isStreaming && (
              <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Loading
              </Badge>
            )}
          </div>
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
        ) : !templatesData || !templatesData.templates || templatesData.templates.length === 0 || error ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No templates available
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              {error || templatesData?.message || "Check back soon for new presentation templates"}
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-6">
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const imageUrl = getImageUrl(template.id, template.has_image)
                  const isLoaded = loadedImages.has(template.id)

                  return (
                    <div
                      key={template.id}
                      onClick={() => handleTemplateClick(template.id)}
                      className="group rounded-lg cursor-pointer transition-all duration-200 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-lg hover:scale-[1.01]"
                    >
                      <div className="relative rounded-t-lg overflow-hidden bg-muted">
                        {imageUrl ? (
                          <>
                            {/* Loading skeleton */}
                            {!isLoaded && (
                              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 animate-pulse">
                                <div className="flex flex-col items-center gap-2">
                                  <Loader2 className="h-8 w-8 text-zinc-400 dark:text-zinc-600 animate-spin" />
                                  <span className="text-xs text-zinc-400 dark:text-zinc-600">Loading...</span>
                                </div>
                              </div>
                            )}
                            
                            {/* Image with fade-in transition */}
                            <Image
                              src={imageUrl}
                              alt={template.name}
                              width={400}
                              height={192}
                              className={`w-full h-full object-contain transition-opacity duration-300 ${
                                isLoaded ? 'opacity-100' : 'opacity-0'
                              }`}
                              onLoad={() => handleImageLoad(template.id)}
                              unoptimized
                            />
                          </>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5">
                            <Sparkles className="h-12 w-12 text-primary/40" />
                          </div>
                        )}
                      </div>
                      <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
                        <p className="text-sm font-medium text-center text-zinc-900 dark:text-zinc-100">
                          {template.name.replace(/_/g, " ")}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <div className="px-4 py-2 h-9 bg-zinc-50/30 dark:bg-zinc-900/30 border-t border-zinc-200/30 dark:border-zinc-800/30 flex justify-between items-center">
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {templates.length > 0 && !isStreaming && (
            <span className="font-mono">{templates.length} templates</span>
          )}
        </div>
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {formatTimestamp(toolTimestamp)}
        </div>
      </div>
    </Card>
  )
}
