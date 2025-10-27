import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface MakeCallData {
  phone_number: string;
  first_message: string;
  call_id: string;
  status: string;
  message?: string;
}

export interface CallStatusData {
  call_id: string;
  status: string;
  phone_number: string;
  duration_seconds?: number;
  started_at?: string;
  ended_at?: string;
  transcript?: Array<{ role: string; message: string }>;
  cost?: number;
}

export interface EndCallData {
  call_id: string;
  status: string;
  message?: string;
}

export interface ListCallsData {
  calls: Array<{
    call_id: string;
    phone_number: string;
    status: string;
    duration_seconds?: number;
    started_at?: string;
  }>;
  count: number;
}

export interface WaitForCallCompletionData {
  call_id: string;
  final_status: string;
  duration_seconds?: number;
  cost?: number;
  message?: string;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractMakeCallData(toolData: ParsedToolData): MakeCallData {
  const { arguments: args, result } = toolData;
  
  const output = typeof result.output === 'string' 
    ? parseContent(result.output) 
    : result.output;
  
  return {
    phone_number: output?.phone_number || args?.phone_number || '',
    first_message: args?.first_message || '',
    call_id: output?.call_id || '',
    status: output?.status || 'queued',
    message: output?.message
  };
}

export function extractCallStatusData(toolData: ParsedToolData): CallStatusData {
  const { result } = toolData;
  
  const output = typeof result.output === 'string' 
    ? parseContent(result.output) 
    : result.output;
  
  let transcript = output?.transcript;
  if (transcript && typeof transcript === 'string') {
    const messages: Array<{ role: string; message: string }> = [];
    const lines = transcript.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const aiMatch = line.match(/^AI:\s*(.+)$/);
      const userMatch = line.match(/^(User|Caller|Human):\s*(.+)$/i);
      
      if (aiMatch) {
        messages.push({ role: 'assistant', message: aiMatch[1].trim() });
      } else if (userMatch) {
        messages.push({ role: 'user', message: userMatch[2].trim() });
      }
    }
    
    transcript = messages.length > 0 ? messages : undefined;
  }
  
  return {
    call_id: output?.call_id || '',
    status: output?.status || 'unknown',
    phone_number: output?.phone_number || '',
    duration_seconds: output?.duration_seconds || output?.duration,
    started_at: output?.started_at,
    ended_at: output?.ended_at,
    transcript,
    cost: output?.cost
  };
}

export function extractEndCallData(toolData: ParsedToolData): EndCallData {
  const { result } = toolData;
  
  const output = typeof result.output === 'string' 
    ? parseContent(result.output) 
    : result.output;
  
  return {
    call_id: output?.call_id || '',
    status: output?.status || 'ended',
    message: output?.message
  };
}

export function extractListCallsData(toolData: ParsedToolData): ListCallsData {
  const { result } = toolData;
  
  const output = typeof result.output === 'string' 
    ? parseContent(result.output) 
    : result.output;
  
  return {
    calls: output?.calls || [],
    count: output?.count || 0
  };
}

export function extractWaitForCallCompletionData(toolData: ParsedToolData): WaitForCallCompletionData {
  const { result } = toolData;
  
  const output = typeof result.output === 'string' 
    ? parseContent(result.output) 
    : result.output;
  
  return {
    call_id: output?.call_id || '',
    final_status: output?.final_status || 'unknown',
    duration_seconds: output?.duration_seconds,
    cost: output?.cost,
    message: output?.message
  };
}

export function formatPhoneNumber(phoneNumber: string): string {
  if (!phoneNumber) return 'Unknown';
  
  if (phoneNumber.startsWith('+1') && phoneNumber.length === 12) {
    const areaCode = phoneNumber.substring(2, 5);
    const firstPart = phoneNumber.substring(5, 8);
    const secondPart = phoneNumber.substring(8);
    return `+1 (${areaCode}) ${firstPart}-${secondPart}`;
  }
  
  return phoneNumber;
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '0s';
  
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export const statusConfig = {
  queued: { label: 'Queued', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-500/10' },
  ringing: { label: 'Ringing', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/10' },
  'in-progress': { label: 'In Progress', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-500/10' },
  completed: { label: 'Completed', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
  ended: { label: 'Ended', color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-500/10' },
  failed: { label: 'Failed', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10' },
};

