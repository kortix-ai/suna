import type React from "react"
import { Check, ListTodo, X, Circle, CircleCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { KortixLoader } from "@/components/ui/kortix-loader"
import { extractTaskListData, type Task, type Section } from "./_utils"
import { getToolTitle } from "../utils"
import type { ToolViewProps } from "../types"
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToolViewHeader } from "../shared/ToolViewHeader"
import { ToolViewFooter } from "../shared/ToolViewFooter"

const TaskItem: React.FC<{ task: Task; index: number }> = ({ task, index }) => {
  const isCompleted = task.status === "completed"
  const isCancelled = task.status === "cancelled"
  const isPending = !isCompleted && !isCancelled

  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/50 transition-colors border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
      {/* Status Icon */}
      <div className="flex-shrink-0">
        {isCompleted && <CircleCheck className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />}
        {isCancelled && <X className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />}
        {isPending && <Circle className="h-4 w-4 text-zinc-400 dark:text-zinc-600" />}
      </div>

      {/* Task Content */}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-sm leading-relaxed",
            isCompleted && "text-zinc-900 dark:text-zinc-100",
            isCancelled && "text-zinc-500 dark:text-zinc-400 line-through",
            isPending && "text-zinc-600 dark:text-zinc-300",
          )}
        >
          {task.content}
        </p>
      </div>
    </div>
  )
}

const SectionHeader: React.FC<{ section: Section }> = ({ section }) => {
  const totalTasks = section.tasks.length
  const completedTasks = section.tasks.filter((t) => t.status === "completed").length

  return (
    <div className="flex items-center justify-between py-3 px-4 bg-zinc-50/80 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-700">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{section.title}</h3>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-xs h-5 px-2 py-0 font-normal bg-white dark:bg-zinc-800">
          {completedTasks}/{totalTasks}
        </Badge>
        {completedTasks === totalTasks && totalTasks > 0 && (
          <Badge variant="outline" className="text-xs h-5 px-2 py-0 bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700">
            <Check className="h-3 w-3" />
          </Badge>
        )}
      </div>
    </div>
  )
}

const SectionView: React.FC<{ section: Section }> = ({ section }) => {
  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
      <SectionHeader section={section} />
      <div className="bg-card">
        {section.tasks.map((task, index) => (
          <TaskItem key={task.id} task={task} index={index} />
        ))}
        {section.tasks.length === 0 && (
          <div className="py-6 px-4 text-center">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">No tasks in this section</p>
          </div>
        )}
      </div>
    </div>
  )
}



export const TaskListToolView: React.FC<ToolViewProps> = ({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false
}) => {
  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const taskData = extractTaskListData(toolCall.arguments, toolResult?.output)
  const toolTitle = getToolTitle(name)

  // Process task data
  const sections = taskData?.sections || []
  const allTasks = sections.flatMap((section) => section.tasks)
  const totalTasks = taskData?.total_tasks || 0

  const completedTasks = allTasks.filter((t) => t.status === "completed").length
  const hasData = taskData?.total_tasks && taskData?.total_tasks > 0

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <ToolViewHeader icon={ListTodo} title={toolTitle}>
        {!isStreaming && (
          <Badge variant="outline" className="text-xs font-normal">
            {completedTasks} / {totalTasks} tasks
          </Badge>
        )}
      </ToolViewHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !hasData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-zinc-100 dark:bg-zinc-800 shadow-inner">
              <KortixLoader size="medium" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Loading Tasks
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Preparing your task list...
            </p>
          </div>
        ) : hasData ? (
          <ScrollArea className="h-full w-full">
            <div className="py-0">
              {sections.map((section) => <SectionView key={section.id} section={section} />)}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-zinc-100 dark:bg-zinc-800 shadow-inner">
              <ListTodo className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Tasks Yet
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Your task list will appear here once created
            </p>
          </div>
        )}
      </CardContent>
      
      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && hasData && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-6 py-0.5">
              <ListTodo className="h-3 w-3" />
              {sections.length} sections
            </Badge>
            {completedTasks === totalTasks && totalTasks > 0 && (
              <Badge variant="outline" className="h-6 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700">
                <Check className="h-3 w-3" />
                All complete
              </Badge>
            )}
          </div>
        )}
      </ToolViewFooter>
    </Card>
  )
}
