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
    <View className="bg-card border border-border rounded-3xl px-6 py-3">
      <View className="flex-row items-center gap-3">
        <View className="flex-shrink-0">
          {isCompleted && <Icon as={CircleCheck} size={16} className="text-muted-foreground" />}
          {isCancelled && <Icon as={X} size={16} className="text-muted-foreground" />}
          {isPending && <Icon as={Circle} size={16} className="text-muted-foreground" />}
        </View>

        <View className="flex-1 min-w-0">
          <Text
            className={cn(
              "text-sm leading-relaxed text-foreground",
              (isCancelled || isPending) && "text-muted-foreground",
              isCancelled && "line-through"
            )}
          >
            {task.content.replace(/\s*-\s*(COMPLETED|IN PROGRESS|CANCELLED|PENDING)\s*$/i, '')}
          </Text>
        </View>
      </View>
    </View>
  );
};

const SectionHeader: React.FC<{ section: Section }> = ({ section }) => {
  const totalTasks = section.tasks.length;
  const completedTasks = section.tasks.filter((t) => t.status === "completed").length;

  return (
    <View className="flex-row items-center justify-between mb-2">
      <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
        {section.title}
      </Text>
      <Text className="text-xs font-roobert text-muted-foreground uppercase">
        {completedTasks}/{totalTasks}
      </Text>
    </View>
  );
};

const SectionView: React.FC<{ section: Section }> = ({ section }) => {
  return (
    <View className="mb-6">
      <SectionHeader section={section} />
      <View className="gap-2">
        {section.tasks.map((task, index) => (
          <TaskItem key={task.id} task={task} index={index} />
        ))}
        {section.tasks.length === 0 && (
          <View className="bg-card border border-border rounded-2xl px-6 py-6 items-center">
            <Text className="text-xs text-muted-foreground uppercase">No tasks in this section</Text>
          </View>
        )}
      </View>
    </View>
  );
};

export function TaskListToolView({
  toolCall,
  toolResult,
  assistantMessage,
  toolMessage,
  isSuccess = true,
  isStreaming = false
}: ToolViewProps) {
  console.log('TaskListToolView - Props:', {
    toolCall,
    toolResult,
    assistantMessage,
    toolMessage,
    isSuccess,
    isStreaming
  });

  if (!toolCall || !toolCall.function_name) {
    return null;
  }

  // Extract content from messages for legacy parsing
  const assistantContent = assistantMessage?.content;
  const toolContent = toolMessage?.content;

  // Try to extract from toolResult.output first (new format)
  let taskData = null;
  if (toolResult?.output) {
    let output = toolResult.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        // Keep as string if not JSON
      }
    }

    if (output?.sections && Array.isArray(output.sections)) {
      taskData = {
        sections: output.sections,
        total_tasks: output.total_tasks,
        total_sections: output.total_sections,
      };
    }
  }

  // Fallback to legacy extraction from content
  if (!taskData) {
    taskData = extractTaskListData(assistantContent, toolContent);
  }

  console.log('TaskListToolView - Parsed taskData:', taskData);

  const actualIsSuccess = toolResult?.success !== false && isSuccess;

  const sections = taskData?.sections || [];
  const allTasks = sections.flatMap((section: any) => section.tasks);
  const totalTasks = taskData?.total_tasks || 0;

  const completedTasks = allTasks.filter((t: any) => t.status === "completed").length;
  const hasData = taskData?.total_tasks && taskData?.total_tasks > 0;

  console.log('TaskListToolView - Computed:', {
    sections: sections.length,
    totalTasks,
    completedTasks,
    hasData,
    allTasks: allTasks.map((t: any) => ({ id: t.id, status: t.status, content: t.content }))
  });

  return (
    <View className="flex flex-col overflow-hidden">
      <View className="px-6 py-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-roobert font-bold text-foreground uppercase">
            Task List
          </Text>

          {!isStreaming && (
            <Text className="text-xs font-roobert text-muted-foreground uppercase">
              {completedTasks} / {totalTasks}
            </Text>
          )}
        </View>
      </View>

      <View className="flex-1 px-6">
        {isStreaming && !hasData ? (
          <View className="flex-col items-center justify-center py-12">
            <Icon as={Clock} size={24} className="text-muted-foreground mb-3" />
            <Text className="text-xs font-roobert text-muted-foreground uppercase">
              Loading tasks
            </Text>
          </View>
        ) : hasData ? (
          <ScrollView className="flex-1">
            <View className="py-4">
              {sections.map((section: any) => (
                <SectionView key={section.id} section={section} />
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className="flex-col items-center justify-center py-12">
            <Icon as={ListTodo} size={24} className="text-muted-foreground mb-3" />
            <Text className="text-xs font-roobert text-muted-foreground uppercase">
              No tasks yet
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}