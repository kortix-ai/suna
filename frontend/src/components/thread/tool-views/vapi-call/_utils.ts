export interface MakeCallData {
  phone_number: string;
  first_message: string;
  system_prompt?: string;
  model?: string;
  voice?: string;
  call_id: string;
  status: string;
  original_number?: string;
  message?: string;
  final_status?: string;
  country?: string;
  country_code?: string;
  duration_seconds?: number;
  cost?: number;
  transcript?: Array<{ role: string; message?: string; content?: string }>;
  transcript_count?: number;
  started_at?: string;
  ended_at?: string;
}

export interface CallStatusData {
  call_id: string;
  status: string;
  phone_number: string;
  duration?: number;
  duration_seconds?: number;
  started_at?: string;
  ended_at?: string;
  transcript?: Array<{ role: string; message: string; timestamp?: string }>;
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
    direction: string;
    status: string;
    duration_seconds?: number;
    started_at?: string;
    ended_at?: string;
  }>;
  count: number;
  message?: string;
}

export interface WaitForCallCompletionData {
  call_id: string;
  final_status: string;
  duration_seconds?: number;
  transcript_messages?: number;
  cost?: number;
  message?: string;
}

import { ToolCallData, ToolResultData } from '../types';

export function extractMakeCallData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined
): MakeCallData | null {
  try {
    const args = toolCall.arguments || {};
    let output: any = {};
    
    if (toolResult?.output) {
      if (typeof toolResult.output === 'string') {
        try {
          output = JSON.parse(toolResult.output);
        } catch (e) {
          // If it's an error message, store it
          if (!toolResult.success) {
            output = { error_message: toolResult.output };
          } else {
            output = {};
          }
        }
      } else if (typeof toolResult.output === 'object' && toolResult.output !== null) {
        output = toolResult.output;
      }
    }

    // Convert phone number to string if it's a number
    if (typeof args.phone_number === 'number') {
      args.phone_number = String(args.phone_number);
    }
    if (typeof output.phone_number === 'number') {
      output.phone_number = String(output.phone_number);
    }

    const success = toolResult?.success !== false;

    return {
      phone_number: output.phone_number || args.phone_number || '',
      first_message: args.first_message || output.first_message || '',
      system_prompt: args.system_prompt || output.system_prompt,
      model: args.model || output.model,
      voice: args.voice || output.voice,
      call_id: output.call_id || '',
      status: output.status || (success ? 'queued' : 'failed'),
      original_number: output.original_number,
      message: output.message || output.error_message,
    };
  } catch (e) {
    console.error('Error extracting make call data:', e);
    return null;
  }
}

export function extractCallStatusData(toolResult?: ToolResultData): CallStatusData | null {
  if (!toolResult?.output) return null;

  try {
    let output: any = {};
    
    if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        return null;
      }
    } else if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    }

    let transcript = output.transcript;
    if (transcript) {
      if (typeof transcript === 'string') {
        const messages: Array<{ role: string; message: string }> = [];
        const lines = transcript.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          const aiMatch = line.match(/^AI:\s*(.+)$/);
          const userMatch = line.match(/^(User|Caller|Human):\s*(.+)$/i);
          
          if (aiMatch) {
            messages.push({ role: 'assistant', message: aiMatch[1].trim() });
          } else if (userMatch) {
            messages.push({ role: 'user', message: userMatch[2].trim() });
          } else if (line.trim()) {
            if (messages.length > 0) {
              messages[messages.length - 1].message += ' ' + line.trim();
            } else {
              messages.push({ role: 'assistant', message: line.trim() });
            }
          }
        }
        
        transcript = messages.length > 0 ? messages : undefined;
      } else if (Array.isArray(transcript)) {
        transcript = transcript.map(msg => ({
          role: msg.role || 'assistant',
          message: msg.message || msg.text || '',
          timestamp: msg.timestamp
        }));
      }
    }

    return {
      call_id: output.call_id || '',
      status: output.status || 'queued',
      phone_number: output.phone_number || '',
      duration: output.duration || output.duration_seconds,
      duration_seconds: output.duration_seconds || output.duration,
      started_at: output.started_at,
      ended_at: output.ended_at,
      transcript: transcript,
      cost: output.cost,
    };
  } catch (e) {
    console.error('Error extracting call status data:', e);
    return null;
  }
}

export function extractEndCallData(toolResult?: ToolResultData): EndCallData | null {
  if (!toolResult?.output) return null;

  try {
    let output: any = {};
    
    if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        return null;
      }
    } else if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    }

    return {
      call_id: output.call_id || '',
      status: output.status || 'ended',
      message: output.message,
    };
  } catch (e) {
    console.error('Error extracting end call data:', e);
    return null;
  }
}

export function extractListCallsData(toolResult?: ToolResultData): ListCallsData | null {
  if (!toolResult?.output) return null;

  try {
    let output: any = {};
    
    if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        return null;
      }
    } else if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    }

    return {
      calls: output.calls || [],
      count: output.count || 0,
      message: output.message,
    };
  } catch (e) {
    console.error('Error extracting list calls data:', e);
    return null;
  }
}

export function formatPhoneNumber(phoneNumber: string | undefined): string {
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

export function extractWaitForCallCompletionData(toolResult?: ToolResultData): WaitForCallCompletionData | null {
  if (!toolResult?.output) return null;

  try {
    let output: any = {};
    
    if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        return null;
      }
    } else if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    }

    return {
      call_id: output.call_id || '',
      final_status: output.final_status || 'unknown',
      duration_seconds: output.duration_seconds,
      transcript_messages: output.transcript_messages,
      cost: output.cost,
      message: output.message
    };
  } catch (e) {
    console.error('Error extracting wait for call completion data:', e);
    return null;
  }
}

export const statusConfig = {
  queued: { label: 'Queued', color: 'bg-slate-500/10 text-slate-600 dark:text-slate-400' },
  ringing: { label: 'Ringing', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  'in-progress': { label: 'In Progress', color: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  completed: { label: 'Completed', color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  ended: { label: 'Ended', color: 'bg-gray-500/10 text-gray-600 dark:text-gray-400' },
  failed: { label: 'Failed', color: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};
