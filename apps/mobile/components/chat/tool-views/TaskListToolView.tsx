import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  Check,
  Clock, 
  CheckCircle,
  AlertTriangle,
  ListTodo,
  X,
  Circle,
  CircleCheck
} from 'lucide-react-native';
import { cn } from '@/lib/utils';
import { extractTaskListData, type Task, type Section } from './task-list/_utils';
import type { ToolViewProps } from './types';

const TaskItem: React.FC<{ task: Task; index: number }> = ({ task, index }) => {
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";
  const isPending = !isCompleted && !isCancelled;

  return (
    <View className="flex-row items-center gap-3 py-3 px-4 border-b border-zinc-100 dark:border-zinc-800">
      <View className="flex-shrink-0">
        {isCompleted && <Icon as={CircleCheck} size={16} className="text-green-500 dark:text-green-400" />}
        {isCancelled && <Icon as={X} size={16} className="text-red-500 dark:text-red-400" />}
        {isPending && <Icon as={Circle} size={16} className="text-zinc-400 dark:text-zinc-600" />}
      </View>

      <View className="flex-1 min-w-0">
        <Text
          className={cn(
            "text-sm leading-relaxed",
            isCompleted && "text-zinc-900 dark:text-zinc-100",
            isCancelled && "text-zinc-500 dark:text-zinc-400 line-through",
            isPending && "text-zinc-600 dark:text-zinc-300"
          )}
        >
          {task.content}
        </Text>
      </View>
    </View>
  );
};

const SectionHeader: React.FC<{ section: Section }> = ({ section }) => {
  const totalTasks = section.tasks.length;
  const completedTasks = section.tasks.filter((t) => t.status === "completed").length;

  return (
    <View className="flex-row items-center justify-between py-3 px-4 bg-zinc-50/80 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-700">
      <Text className="text-sm font-roobert-medium text-zinc-700 dark:text-zinc-300">{section.title}</Text>
      <View className="flex-row items-center gap-2">
        <View className="px-2 py-0.5 rounded border border-border bg-white dark:bg-zinc-800">
          <Text className="text-xs font-roobert text-foreground">
            {completedTasks}/{totalTasks}
          </Text>
        </View>
        {completedTasks === totalTasks && totalTasks > 0 && (
          <View className="px-2 py-0.5 rounded bg-green-50 border border-green-200 dark:bg-green-900/20 dark:border-green-800">
            <Icon as={Check} size={12} className="text-green-700 dark:text-green-400" />
          </View>
        )}
      </View>
    </View>
  );
};

const SectionView: React.FC<{ section: Section }> = ({ section }) => {
  return (
    <View className="border-b border-zinc-200 dark:border-zinc-800">
      <SectionHeader section={section} />
      <View className="bg-card">
        {section.tasks.map((task, index) => (
          <TaskItem key={task.id} task={task} index={index} />
        ))}
        {section.tasks.length === 0 && (
          <View className="py-6 px-4 items-center">
            <Text className="text-xs text-zinc-500 dark:text-zinc-400">No tasks in this section</Text>
          </View>
        )}
      </View>
    </View>
  );
};

export function TaskListToolView({ 
  toolData, 
  assistantMessage, 
  toolMessage, 
  isStreaming = false 
}: ToolViewProps) {
  const assistantContent = assistantMessage?.content;
  const toolContent = toolMessage?.content;
  
  const taskData = extractTaskListData(assistantContent, toolContent);
  const toolName = toolData.toolName || 'task-list';
  const isSuccess = toolData.result?.success !== false;

  const sections = taskData?.sections || [];
  const allTasks = sections.flatMap((section) => section.tasks);
  const totalTasks = taskData?.total_tasks || 0;

  const completedTasks = allTasks.filter((t) => t.status === "completed").length;
  const hasData = taskData?.total_tasks && taskData?.total_tasks > 0;

  return (
    <View className="flex flex-col overflow-hidden bg-card border-t border-zinc-200 dark:border-zinc-800">
      <View className="bg-zinc-50/80 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
              <Icon as={ListTodo} size={20} className="text-zinc-700 dark:text-zinc-300" />
            </View>
            <View>
              <Text className="text-base font-roobert-medium text-zinc-900 dark:text-zinc-100">
                Task List
              </Text>
            </View>
          </View>

          {!isStreaming && (
            <View className="flex-row items-center gap-2">
              <View className="px-2 py-1 rounded border border-border">
                <Text className="text-xs font-roobert">
                  {completedTasks} / {totalTasks} tasks
                </Text>
              </View>
              <View className={cn(
                "px-2 py-1 rounded flex-row items-center gap-1",
                isSuccess 
                  ? "bg-emerald-100 dark:bg-emerald-900/30" 
                  : "bg-rose-100 dark:bg-rose-900/30"
              )}>
                <Icon 
                  as={isSuccess ? CheckCircle : AlertTriangle} 
                  size={14} 
                  className={isSuccess ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}
                />
                <Text className={cn(
                  "text-xs font-roobert-medium",
                  isSuccess 
                    ? "text-emerald-700 dark:text-emerald-300" 
                    : "text-rose-700 dark:text-rose-300"
                )}>
                  {isSuccess ? 'Tasks loaded' : 'Failed to load'}
                </Text>
              </View>
            </View>
          )}
        </View>
      </View>

      <View className="flex-1">
        {isStreaming && !hasData ? (
          <View className="flex-col items-center justify-center py-12 px-6 bg-white dark:bg-zinc-950">
            <View className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-zinc-100 dark:bg-zinc-800/40">
              <Icon as={Clock} size={40} className="text-zinc-500 dark:text-zinc-400" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Loading Tasks
            </Text>
            <Text className="text-sm text-zinc-500 dark:text-zinc-400">
              Preparing your task list...
            </Text>
          </View>
        ) : hasData ? (
          <ScrollView className="flex-1">
            <View className="py-0">
              {sections.map((section) => (
                <SectionView key={section.id} section={section} />
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className="flex-col items-center justify-center py-12 px-6 bg-white dark:bg-zinc-950">
            <View className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-zinc-100 dark:bg-zinc-800/40">
              <Icon as={ListTodo} size={40} className="text-zinc-400 dark:text-zinc-600" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Tasks Yet
            </Text>
            <Text className="text-sm text-zinc-500 dark:text-zinc-400">
              Your task list will appear here once created
            </Text>
          </View>
        )}
      </View>
      
      <View className="px-4 py-2 bg-zinc-50/90 dark:bg-zinc-900/90 border-t border-zinc-200 dark:border-zinc-800 flex-row justify-between items-center">
        <View className="flex-row items-center gap-2">
          {!isStreaming && hasData && (
            <View className="flex-row items-center gap-2">
              <View className="px-2 py-1 rounded border border-border flex-row items-center gap-1">
                <Icon as={ListTodo} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert text-foreground">
                  {sections.length} sections
                </Text>
              </View>
              {completedTasks === totalTasks && totalTasks > 0 && (
                <View className="px-2 py-1 rounded bg-green-50 border border-green-200 dark:bg-green-900/20 dark:border-green-700 flex-row items-center gap-1">
                  <Icon as={Check} size={12} className="text-green-600 dark:text-green-400" />
                  <Text className="text-xs font-roobert text-green-600 dark:text-green-400">
                    All complete
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
        <Text className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolMessage?.created_at ? new Date(toolMessage.created_at).toLocaleTimeString() : ''}
        </Text>
      </View>
    </View>
  );
}
