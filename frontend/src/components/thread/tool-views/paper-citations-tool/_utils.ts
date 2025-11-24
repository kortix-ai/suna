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
        // Error handling
      }
    }
    parsedOutput = parsedOutput || {};

    return {
      paper_id: args.paper_id || parsedOutput?.paper_id || null,
      citations_returned: parsedOutput?.citations_returned || 0,
      offset: parsedOutput?.offset,
      next_offset: parsedOutput?.next_offset,
      has_more: parsedOutput?.has_more,
      citations: (parsedOutput?.citations || []).map((citation: any) => ({
        rank: citation.rank || 0,
        is_influential: citation.is_influential || false,
        contexts: Array.isArray(citation.contexts) ? citation.contexts : [],
        intents: Array.isArray(citation.intents) ? citation.intents : [],
        citing_paper: {
          paper_id: citation.citing_paper?.paper_id || citation.paper_id || '',
          title: citation.citing_paper?.title || citation.title || '',
          year: citation.citing_paper?.year || citation.year,
          authors: Array.isArray(citation.citing_paper?.authors) 
            ? citation.citing_paper.authors 
            : Array.isArray(citation.authors) 
              ? citation.authors 
              : [],
          citation_count: citation.citing_paper?.citation_count || citation.citation_count || 0,
          url: citation.citing_paper?.url || citation.url || '',
          venue: citation.citing_paper?.venue || citation.venue,
          abstract: citation.citing_paper?.abstract || citation.abstract
        }
      })),
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
      citations: (parsedContent.citations || []).map((citation: any) => ({
        rank: citation.rank || 0,
        is_influential: citation.is_influential || false,
        contexts: Array.isArray(citation.contexts) ? citation.contexts : [],
        intents: Array.isArray(citation.intents) ? citation.intents : [],
        citing_paper: {
          paper_id: citation.citing_paper?.paper_id || citation.paper_id || '',
          title: citation.citing_paper?.title || citation.title || '',
          year: citation.citing_paper?.year || citation.year,
          authors: Array.isArray(citation.citing_paper?.authors) 
            ? citation.citing_paper.authors 
            : Array.isArray(citation.authors) 
              ? citation.authors 
              : [],
          citation_count: citation.citing_paper?.citation_count || citation.citation_count || 0,
          url: citation.citing_paper?.url || citation.url || '',
          venue: citation.citing_paper?.venue || citation.venue,
          abstract: citation.citing_paper?.abstract || citation.abstract
        }
      })),
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
    // Fallback: try to extract from raw tool data
    // extractToolData doesn't return citations directly, so we'll just use empty defaults
    // The new format extraction should handle most cases
    data = {
      paper_id: null,
      citations_returned: 0,
      citations: [],
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
