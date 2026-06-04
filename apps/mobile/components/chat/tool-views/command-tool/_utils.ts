import type { ToolCallData, ToolResultData } from '../types';

export interface CommandData {
  command: string | null;
  output: string | null;
  exitCode: number | null;
  sessionName: string | null;
  cwd: string | null;
  completed: boolean | null;
  success?: boolean;
  timestamp?: string;
}

/**
 * Extract command data from structured metadata props
 * NO CONTENT PARSING - uses toolCall.arguments and toolResult.output directly
 */
export function extractCommandData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CommandData {
  // Extract command from toolCall.arguments (from metadata)
  // Handle both object and string (partial JSON during streaming)
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      // Try to parse - may be incomplete JSON during streaming
      try {
        args = JSON.parse(toolCall.arguments);
      } catch (e) {
        // Invalid or incomplete JSON - treat as raw string
        // During streaming, arguments might be partial
        args = { command: toolCall.arguments };
      }
    }
  }
  
  const command = args.command || null;
  const sessionName = args.session_name || args.sessionName || null;
  const cwd = args.cwd || args.working_directory || null;

  // Extract output from toolResult.output (from metadata)
  let output: string | null = null;
  let exitCode: number | null = null;
  let completed: boolean | null = null;
  let actualIsSuccess = isSuccess;

  if (toolResult?.output) {
    // Handle structured output object
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      const outputObj = toolResult.output as any;
      output = outputObj.output || outputObj.stdout || outputObj.content || JSON.stringify(outputObj, null, 2);
      exitCode = outputObj.exit_code ?? outputObj.exitCode ?? null;
      completed = outputObj.completed ?? outputObj.finished ?? null;
    } else if (typeof toolResult.output === 'string') {
      output = toolResult.output;
    }

    // Use success from toolResult if available
    if (toolResult.success !== undefined) {
      actualIsSuccess = toolResult.success;
    }
  }

  return {
    command,
    output,
    exitCode,
    sessionName,
    cwd,
    completed,
    success: actualIsSuccess,
    timestamp: toolTimestamp,
  };
}

