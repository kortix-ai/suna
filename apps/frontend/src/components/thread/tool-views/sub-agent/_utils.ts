/**
 * Sub-Agent Tool View Utilities
 */

export interface SubAgentInfo {
  sub_agent_id: string;
  thread_id: string;
  task: string;
  status: 'spawned' | 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  error?: string | null;
  started_at?: string;
  completed_at?: string;
  result?: string;
}

export interface SubAgentListData {
  sub_agents: SubAgentInfo[];
  total: number;
  status_summary: Record<string, number>;
  message?: string;
  timed_out?: boolean;
}

export interface SubAgentSpawnData {
  sub_agent_id: string;
  thread_id: string;
  task: string;
  status: string;
  message: string;
}

export interface SubAgentResultData {
  sub_agent_id: string;
  thread_id: string;
  task: string;
  status: string;
  error?: string | null;
  result: string;
  completed_at?: string;
}

/**
 * Parse output string into object if needed
 */
function parseOutput(output: any): any {
  if (!output) return null;
  
  if (typeof output === 'string') {
    try {
      return JSON.parse(output);
    } catch {
      return { message: output };
    }
  }
  
  return output;
}

/**
 * Extract data for spawn_sub_agent tool call
 */
export function extractSpawnData(
  argumentsData?: Record<string, any>,
  outputData?: any
): SubAgentSpawnData | null {
  const output = parseOutput(outputData);
  
  if (output?.sub_agent_id) {
    return {
      sub_agent_id: output.sub_agent_id,
      thread_id: output.thread_id,
      task: output.task || argumentsData?.task || 'Unknown task',
      status: output.status || 'spawned',
      message: output.message || 'Sub-agent spawned'
    };
  }
  
  // Fallback to arguments for streaming state
  if (argumentsData?.task) {
    return {
      sub_agent_id: '',
      thread_id: '',
      task: argumentsData.task,
      status: 'spawning',
      message: 'Spawning sub-agent...'
    };
  }
  
  return null;
}

/**
 * Extract data for list_sub_agents tool call
 */
export function extractListData(
  argumentsData?: Record<string, any>,
  outputData?: any
): SubAgentListData | null {
  const output = parseOutput(outputData);
  
  if (output?.sub_agents !== undefined) {
    return {
      sub_agents: output.sub_agents || [],
      total: output.total || 0,
      status_summary: output.status_summary || {},
      message: output.message,
      timed_out: output.timed_out
    };
  }
  
  return null;
}

/**
 * Extract data for get_sub_agent_result tool call
 */
export function extractResultData(
  argumentsData?: Record<string, any>,
  outputData?: any
): SubAgentResultData | null {
  const output = parseOutput(outputData);
  
  if (output?.sub_agent_id) {
    return {
      sub_agent_id: output.sub_agent_id,
      thread_id: output.thread_id,
      task: output.task || 'Unknown task',
      status: output.status || 'unknown',
      error: output.error,
      result: output.result || '(No output)',
      completed_at: output.completed_at
    };
  }
  
  return null;
}

/**
 * Get status badge color for sub-agent status
 */
export function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800';
    case 'running':
    case 'spawned':
    case 'pending':
      return 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800';
    case 'failed':
    case 'stopped':
      return 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800';
    default:
      return 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:border-zinc-700';
  }
}

/**
 * Get status icon name for sub-agent status
 */
export function getStatusIcon(status: string): 'check' | 'loader' | 'x' | 'circle' {
  switch (status) {
    case 'completed':
      return 'check';
    case 'running':
    case 'spawned':
    case 'pending':
      return 'loader';
    case 'failed':
    case 'stopped':
      return 'x';
    default:
      return 'circle';
  }
}

