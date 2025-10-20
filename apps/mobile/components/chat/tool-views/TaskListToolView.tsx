/**
 * Task List Tool View
 * 
 * Specialized view for task management operations
 */

import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  CheckSquare, 
  Square,
  ListTodo,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Clock
} from 'lucide-react-native';
import type { ToolViewProps } from './types';

interface Task {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const STATUS_CONFIG = {
  pending: { 
    icon: Square, 
    color: 'text-foreground/40',
    bgColor: 'bg-card',
    borderColor: 'border-border'
  },
  in_progress: { 
    icon: Clock, 
    color: 'text-primary',
    bgColor: 'bg-primary/5',
    borderColor: 'border-primary/20'
  },
  completed: { 
    icon: CheckSquare, 
    color: 'text-primary',
    bgColor: 'bg-primary/5',
    borderColor: 'border-primary/20'
  },
  cancelled: { 
    icon: Trash2, 
    color: 'text-destructive',
    bgColor: 'bg-destructive/5',
    borderColor: 'border-destructive/20'
  },
};

export function TaskListToolView({ toolData }: ToolViewProps) {
  const { toolName, arguments: toolArgs, result } = toolData;
  const isError = !result.success;

  // Extract tasks from arguments or result
  const tasks: Task[] = React.useMemo(() => {
    // Try to get tasks from arguments
    if (toolArgs.todos && Array.isArray(toolArgs.todos)) {
      return toolArgs.todos;
    }
    if (toolArgs.tasks && Array.isArray(toolArgs.tasks)) {
      return toolArgs.tasks;
    }
    
    // Try to get tasks from result
    if (result.output?.todos && Array.isArray(result.output.todos)) {
      return result.output.todos;
    }
    if (result.output?.tasks && Array.isArray(result.output.tasks)) {
      return result.output.tasks;
    }

    return [];
  }, [toolArgs, result.output]);

  const operation = React.useMemo(() => {
    if (toolName.includes('create')) return 'Created';
    if (toolName.includes('update')) return 'Updated';
    if (toolName.includes('delete')) return 'Deleted';
    if (toolName.includes('view')) return 'Viewed';
    return 'Modified';
  }, [toolName]);

  // Count tasks by status
  const taskStats = React.useMemo(() => {
    const stats = {
      total: tasks.length,
      completed: 0,
      in_progress: 0,
      pending: 0,
      cancelled: 0,
    };
    tasks.forEach(task => {
      if (task.status in stats) {
        stats[task.status]++;
      }
    });
    return stats;
  }, [tasks]);

  return (
    <View className="px-6 py-4 gap-6">
      {/* Header */}
      <View className="flex-row items-center gap-3">
        <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
          <Icon as={ListTodo} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            Task Management
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            {operation} Tasks
          </Text>
        </View>
      </View>

      {/* Task Statistics */}
      {tasks.length > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Statistics
          </Text>
          <View className="flex-row items-center gap-2 flex-wrap">
            <View className="bg-card border border-border rounded-full px-3 py-1.5">
              <Text className="text-xs font-roobert-medium text-foreground">
                {taskStats.total} Total
              </Text>
            </View>
            {taskStats.completed > 0 && (
              <View className="bg-primary/10 border border-primary/20 rounded-full px-3 py-1.5">
                <Text className="text-xs font-roobert-medium text-primary">
                  {taskStats.completed} Completed
                </Text>
              </View>
            )}
            {taskStats.in_progress > 0 && (
              <View className="bg-primary/10 border border-primary/20 rounded-full px-3 py-1.5">
                <Text className="text-xs font-roobert-medium text-primary">
                  {taskStats.in_progress} In Progress
                </Text>
              </View>
            )}
            {taskStats.pending > 0 && (
              <View className="bg-card border border-border rounded-full px-3 py-1.5">
                <Text className="text-xs font-roobert-medium text-foreground/60">
                  {taskStats.pending} Pending
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Tasks List */}
      {tasks.length > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Tasks
          </Text>
          <ScrollView className="gap-3" style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            {tasks.map((task, index) => {
              const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
              const StatusIcon = config.icon;

              return (
                <View
                  key={task.id || index}
                  className={`flex-row items-start gap-3 p-4 rounded-2xl border ${config.bgColor} ${config.borderColor}`}
                >
                  <View className="pt-0.5">
                    <Icon 
                      as={StatusIcon} 
                      size={18} 
                      className={config.color} 
                    />
                  </View>
                  <View className="flex-1 gap-1.5">
                    <Text 
                      className={`text-sm font-roobert text-foreground ${
                        task.status === 'completed' ? 'line-through opacity-60' : ''
                      } ${task.status === 'cancelled' ? 'line-through opacity-40' : ''}`}
                    >
                      {task.content}
                    </Text>
                    <View className={`self-start px-2 py-0.5 rounded-full ${config.bgColor}`}>
                      <Text className={`text-xs font-roobert-medium ${config.color}`}>
                        {task.status.replace('_', ' ')}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Status */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          Status
        </Text>
        <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${
          isError 
            ? 'bg-destructive/5 border-destructive/20' 
            : 'bg-primary/5 border-primary/20'
        }`}>
          <Icon 
            as={isError ? AlertCircle : CheckCircle2} 
            size={18} 
            className={isError ? 'text-destructive' : 'text-primary'} 
          />
          <Text className={`text-sm font-roobert-medium ${
            isError ? 'text-destructive' : 'text-primary'
          }`}>
            {isError ? 'Operation Failed' : 'Operation Successful'}
          </Text>
        </View>
        {result.output && typeof result.output === 'string' && (
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground/80">
              {result.output}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
