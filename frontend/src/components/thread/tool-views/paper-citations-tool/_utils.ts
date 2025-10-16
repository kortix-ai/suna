import { extractToolData } from '../utils';

export interface CitingPaper {
  paper_id: string;
  title: string;
  year?: number;
  authors: string[];
  citation_count: number;
  url: string;
  venue?: string;
  abstract?: string;
}

export interface PaperCitation {
  rank: number;
  is_influential: boolean;
  contexts: string[];
  intents: string[];
  citing_paper: CitingPaper;
}

export interface PaperCitationsData {
  paper_id: string | null;
  citations_returned: number;
  offset?: number;
  next_offset?: number | null;
  has_more?: boolean;
  citations: PaperCitation[];
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

const extractFromNewFormat = (content: any): PaperCitationsData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {
      paper_id: null,
      citations_returned: 0,
      citations: [],
      success: undefined,
      timestamp: undefined
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }
    parsedOutput = parsedOutput || {};

    return {
      paper_id: args.paper_id || parsedOutput?.paper_id || null,
      citations_returned: parsedOutput?.citations_returned || 0,
      offset: parsedOutput?.offset,
      next_offset: parsedOutput?.next_offset,
      has_more: parsedOutput?.has_more,
      citations: parsedOutput?.citations || [],
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
  }

  if ('paper_id' in parsedContent && 'citations' in parsedContent) {
    return {
      paper_id: parsedContent.paper_id || null,
      citations_returned: parsedContent.citations_returned || parsedContent.citations?.length || 0,
      offset: parsedContent.offset,
      next_offset: parsedContent.next_offset,
      has_more: parsedContent.has_more,
      citations: parsedContent.citations || [],
      success: true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {
    paper_id: null,
    citations_returned: 0,
    citations: [],
    success: undefined,
    timestamp: undefined
  };
};

const extractFromLegacyFormat = (content: any): Omit<PaperCitationsData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    return {
      paper_id: null,
      citations_returned: 0,
      citations: []
    };
  }

  return {
    paper_id: null,
    citations_returned: 0,
    citations: []
  };
};

export function extractPaperCitationsData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  paper_id: string | null;
  citations_returned: number;
  has_more: boolean;
  citations: PaperCitation[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: PaperCitationsData = {
    paper_id: null,
    citations_returned: 0,
    citations: []
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.paper_id || assistantNewFormat.citations.length > 0) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.paper_id || toolNewFormat.citations.length > 0) {
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
      paper_id: assistantLegacy.paper_id || toolLegacy.paper_id,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    paper_id: data.paper_id,
    citations_returned: data.citations_returned,
    has_more: data.has_more || false,
    citations: data.citations,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}
