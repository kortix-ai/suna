import { extractToolData } from '../utils';

interface AuthorPaper {
  paper_id: string;
  title: string;
  year?: number;
  citation_count: number;
  url: string;
  venue?: string;
  abstract?: string;
}

export interface AuthorDetails {
  author_id: string;
  name: string;
  url: string;
  affiliations: string[];
  homepage?: string;
  paper_count: number;
  citation_count: number;
  h_index: number;
  external_ids?: Record<string, any>;
  papers?: AuthorPaper[] | null;
}

export interface AuthorDetailsData {
  author: AuthorDetails | null;
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

const extractFromNewFormat = (content: any): AuthorDetailsData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {
      author: null,
      success: undefined,
      timestamp: undefined
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }
    parsedOutput = parsedOutput || {};

    return {
      author: parsedOutput.author || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
  }

  if ('output' in parsedContent && typeof parsedContent.output === 'object') {
    const output = parsedContent.output;
    if (typeof output === 'string') {
      try {
        const parsedOutput = JSON.parse(output);
        return {
          author: parsedOutput.author || null,
          success: parsedContent.success,
          timestamp: undefined
        };
      } catch (e) {
      }
    }
    return {
      author: output.author || null,
      success: parsedContent.success,
      timestamp: undefined
    };
  }

  if ('author' in parsedContent) {
    return {
      author: parsedContent.author || null,
      success: parsedContent.success !== undefined ? parsedContent.success : true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {
    author: null,
    success: undefined,
    timestamp: undefined
  };
};

const extractFromLegacyFormat = (content: any): Omit<AuthorDetailsData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    return {
      author: null
    };
  }

  return {
    author: null
  };
};

export function extractAuthorDetailsData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  author: AuthorDetails | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: AuthorDetailsData = {
    author: null
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.author) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.author) {
    data = toolNewFormat;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    data = {
      ...assistantLegacy,
      ...toolLegacy,
      author: assistantLegacy.author || toolLegacy.author,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    author: data.author,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}

