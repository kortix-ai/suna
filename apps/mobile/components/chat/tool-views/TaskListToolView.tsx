import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Clock,
  ListTodo,
  X,
  Circle,
  CircleCheck
} from 'lucide-react-native';
import { extractTaskListData, type Task, type Section } from './task-list/_utils';
import type { ToolViewProps } from './types';
import { ToolViewCard, StatusBadge, LoadingState } from './shared';

const TaskItem: React.FC<{ task: Task; index: number }> = ({ task, index }) => {
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";
  const isPending = !isCompleted && !isCancelled;

  return (
    <View className="bg-card border border-border rounded-3xl px-6 py-3">
      <View className="flex-row items-center gap-3">
        <View className="flex-shrink-0">
          {isCompleted && <Icon as={CircleCheck} size={16} className="text-primary" />}
          {isCancelled && <Icon as={X} size={16} className="text-muted-foreground" />}
          {isPending && <Icon as={Circle} size={16} className="text-muted-foreground" />}
        </View>

        <View className="flex-1 min-w-0">
          <Text
            className={`text-sm leading-relaxed ${
              isCompleted ? 'text-foreground' : isCancelled ? 'text-muted-foreground line-through' : 'text-muted-foreground'
            }`}
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

  const actualIsSuccess = toolResult?.success !== false && isSuccess;

  const sections = taskData?.sections || [];
  const allTasks = sections.flatMap((section: any) => section.tasks);
  const totalTasks = taskData?.total_tasks || 0;

  const completedTasks = allTasks.filter((t: any) => t.status === "completed").length;
  const hasData = taskData?.total_tasks && taskData?.total_tasks > 0;

  return (
    <ToolViewCard
      header={{
        icon: ListTodo,
        iconColor: 'text-primary',
        iconBgColor: 'bg-primary/10 border-primary/20',
        subtitle: 'TASK LIST',
        title: 'Task List',
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: !isStreaming && (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={`${completedTasks}/${totalTasks}`}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <Text className="text-xs text-muted-foreground">
            {totalTasks} {totalTasks === 1 ? 'task' : 'tasks'} total
          </Text>
          {completedTasks > 0 && (
            <Text className="text-xs text-muted-foreground">
              {completedTasks} completed
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1 w-full">
        {isStreaming && !hasData ? (
          <LoadingState
            icon={ListTodo}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Loading tasks"
            showProgress={true}
          />
        ) : hasData ? (
          <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
            <View className="px-4 py-4">
              {sections.map((section: any) => (
                <SectionView key={section.id} section={section} />
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className="flex-1 items-center justify-center py-12 px-6">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
              <Icon as={ListTodo} size={40} className="text-muted-foreground" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
              No Tasks Yet
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              Tasks will appear here when created
            </Text>
          </View>
        )}
      </View>
    </ToolViewCard>
  );
}
