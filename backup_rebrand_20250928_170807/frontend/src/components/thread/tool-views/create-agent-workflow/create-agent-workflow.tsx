import React from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Settings,
  Star,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { extractCreateAgentWorkflowData } from './_utils';
import { useState } from 'react';

export default function CreateAgentWorkflowToolView({
  name = 'create-agent-workflow',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [isTemplateOpen, setIsTemplateOpen] = useState(false);
  const {
    agent_id,
    name: workflowName,
    template,
    variables,
    description,
    is_default,
    workflow,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCreateAgentWorkflowData(
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
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <FileText className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
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
              {actualIsSuccess ? 'Workflow created' : 'Creation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={FileText}
            iconColor="text-emerald-500 dark:text-emerald-400"
            bgColor="bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60 dark:shadow-emerald-950/20"
            title="Creating workflow"
            filePath={workflowName ? `"${workflowName}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && workflow ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
                <div className="border border-border rounded-xl p-4 space-y-4 bg-muted/20 dark:bg-muted/10">
                 <div className="flex items-start justify-between">
                   <div className="flex items-center gap-3">
                     <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20 flex items-center justify-center">
                       <FileText className="h-6 w-6 text-emerald-600" />
                     </div>
                     <div className="space-y-1">
                       <h3 className="font-semibold text-foreground">{workflow.name}</h3>
                       {description && (
                         <p className="text-sm text-muted-foreground">{description}</p>
                       )}
                     </div>
                   </div>
                   <div className="flex items-center gap-2">
                     <Badge variant="outline" className="text-xs">
                       <Settings className="h-3 w-3 mr-1" />
                       {workflow.status}
                     </Badge>
                     {is_default && (
                       <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">
                         <Star className="h-3 w-3 mr-1" />
                         Default
                       </Badge>
                     )}
                   </div>
                 </div>

                 <Separator />

                 <div className="grid grid-cols-3 gap-4">
                   <div className="text-center p-3 bg-muted rounded-lg">
                     <p className="text-lg font-semibold text-foreground">{workflow.steps_count}</p>
                     <p className="text-xs text-muted-foreground">Steps</p>
                   </div>
                   <div className="text-center p-3 bg-muted rounded-lg">
                     <p className="text-lg font-semibold text-foreground">{workflow.variables_count}</p>
                     <p className="text-xs text-muted-foreground">Variables</p>
                   </div>
                   <div className="text-center p-3 bg-blue-100 dark:bg-blue-950/50 rounded-lg">
                     <p className="text-lg font-semibold text-blue-700 dark:text-blue-400 capitalize">{workflow.status}</p>
                     <p className="text-xs text-blue-600 dark:text-blue-500">Status</p>
                   </div>
                 </div>

                 {variables && variables.length > 0 && (
                   <>
                     <Separator />
                     <div className="space-y-3">
                       <p className="text-sm font-medium text-foreground">Variables ({variables.length})</p>
                       <div className="space-y-2">
                         {variables.map((variable, index) => (
                           <div key={index} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                             <div className="flex-1">
                               <p className="text-sm font-medium text-foreground">{`{{${variable.key}}}`}</p>
                               <p className="text-xs text-muted-foreground">{variable.label}</p>
                             </div>
                           </div>
                         ))}
                       </div>
                     </div>
                   </>
                 )}

                 {template && (
                   <>
                     <Separator />
                     <Collapsible open={isTemplateOpen} onOpenChange={setIsTemplateOpen}>
                       <CollapsibleTrigger className="flex items-center justify-between w-full text-left p-2 hover:bg-muted rounded-lg transition-colors">
                         <p className="text-sm font-medium text-foreground">Workflow Template</p>
                         {isTemplateOpen ? (
                           <ChevronDown className="h-4 w-4 text-muted-foreground" />
                         ) : (
                           <ChevronRight className="h-4 w-4 text-muted-foreground" />
                         )}
                       </CollapsibleTrigger>
                       <CollapsibleContent className="mt-2">
                         <div className="p-3 bg-muted border border-border rounded-lg text-sm text-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">
                           {template}
                         </div>
                       </CollapsibleContent>
                     </Collapsible>
                   </>
                 )}
               </div>
             </div>
           </ScrollArea>
         ) : (
           <div className="p-4 text-center">
             <div className="space-y-2">
               <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
               <p className="text-sm font-medium text-foreground">Failed to create workflow</p>
               <p className="text-xs text-muted-foreground">Please check the workflow configuration and try again.</p>
             </div>
           </div>
         )}
       </CardContent>
     </Card>
   );
 } 