import { extractToolData, extractCommand, extractCommandOutput, extractExitCode, extractSessionName } from '../utils';

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


const extractFromNewFormat = (content: any): CommandData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { command: null, output: null, exitCode: null, sessionName: null, cwd: null, completed: null, success: undefined, timestamp: undefined };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    // Handle the case where result.output is a string (like in your example)
    let output = toolExecution.result?.output;
    let parsedOutput: any = {};
    
    if (typeof output === 'string') {
      // First try to parse it as JSON
      try {
        parsedOutput = JSON.parse(output);
        // If parsing succeeds, extract the actual output from the nested structure
        if (parsedOutput && typeof parsedOutput === 'object') {
          // Look for output in common nested structures
          output = parsedOutput.output || parsedOutput.message || parsedOutput.content || output;
        }
      } catch (e) {
        // If it's not JSON, treat it as plain text output
        output = output;
      }
    } else if (typeof output === 'object' && output !== null) {
      parsedOutput = output;
      // Extract output from object structure
      output = (output as any).output || (output as any).message || (output as any).content || null;
    }

    const extractedData = {
      command: args.command || null,
      output: output || parsedOutput?.output || null,
      exitCode: parsedOutput?.exit_code || null,
      sessionName: args.session_name || parsedOutput?.session_name || null,
      cwd: parsedOutput?.cwd || null,
      completed: parsedOutput?.completed || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { command: null, output: null, exitCode: null, sessionName: null, cwd: null, completed: null, success: undefined, timestamp: undefined };
};


const extractFromLegacyFormat = (content: any): Omit<CommandData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    
    return {
      command: toolData.command || args.command || null,
      output: toolData.toolResult.toolOutput || null,
      exitCode: null,
      sessionName: args.session_name || null,
      cwd: null,
      completed: null
    };
  }

  const legacyCommand = extractCommand(content);
  
  return {
    command: legacyCommand,
    output: null,
    exitCode: null,
    sessionName: null,
    cwd: null,
    completed: null
  };
};

export function extractCommandData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  command: string | null;
  output: string | null;
  exitCode: number | null;
  sessionName: string | null;
  cwd: string | null;
  completed: boolean | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let command: string | null = null;
  let output: string | null = null;
  let exitCode: number | null = null;
  let sessionName: string | null = null;
  let cwd: string | null = null;
  let completed: boolean | null = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.command || assistantNewFormat.output) {
    command = assistantNewFormat.command;
    output = assistantNewFormat.output;
    exitCode = assistantNewFormat.exitCode;
    sessionName = assistantNewFormat.sessionName;
    cwd = assistantNewFormat.cwd;
    completed = assistantNewFormat.completed;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.command || toolNewFormat.output) {
    command = toolNewFormat.command;
    output = toolNewFormat.output;
    exitCode = toolNewFormat.exitCode;
    sessionName = toolNewFormat.sessionName;
    cwd = toolNewFormat.cwd;
    completed = toolNewFormat.completed;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    command = assistantLegacy.command || toolLegacy.command;
    output = assistantLegacy.output || toolLegacy.output;
    sessionName = assistantLegacy.sessionName || toolLegacy.sessionName;
  }

  if (!command) {
    const rawCommand = extractCommand(assistantContent) || extractCommand(toolContent);
    command = rawCommand
      ?.replace(/^suna@computer:~\$\s*/g, '')
      ?.replace(/\\n/g, '')
      ?.replace(/\n/g, '')
      ?.trim() || null;
  }
  
  if (!output && toolContent) {
    output = extractCommandOutput(toolContent);
  }
  
  if (exitCode === null && toolContent) {
    exitCode = extractExitCode(toolContent);
  }

  if (!sessionName) {
    sessionName = extractSessionName(assistantContent) || extractSessionName(toolContent);
  }

  if (output && typeof output === 'string' && output.includes('exit_code=') && exitCode === null) {
    const exitCodeMatch = output.match(/exit_code=(\d+)/);
    if (exitCodeMatch) {
      exitCode = parseInt(exitCodeMatch[1], 10);
    }
  }


  return {
    command,
    output,
    exitCode,
    sessionName,
    cwd,
    completed,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
} 