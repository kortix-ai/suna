import { extractToolData } from '../utils';

export interface AuthorSearchResult {
  rank: number;
  author_id: string;
  name: string;
  url: string;
  affiliations: string[];
  homepage?: string;
  paper_count: number;
  citation_count: number;
  h_index: number;
  external_ids?: Record<string, any>;
}

export interface AuthorSearchData {
  query: string | null;
  total_results: number;
  total_available?: number;
  results_returned?: number;
  results: AuthorSearchResult[];
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

const extractFromNewFormat = (content: any): AuthorSearchData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {
      query: null,
      total_results: 0,
      results: [],
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

    const extractedData = {
      query: args.query || parsedOutput?.query || null,
      total_results: parsedOutput?.total_available || parsedOutput?.total_results || 0,
      total_available: parsedOutput?.total_available,
      results_returned: parsedOutput?.results_returned,
      results: parsedOutput?.results?.map((result: any) => ({
        rank: result.rank || 0,
        author_id: result.author_id || '',
        name: result.name || '',
        url: result.url || '',
        affiliations: result.affiliations || [],
        homepage: result.homepage,
        paper_count: result.paper_count || 0,
        citation_count: result.citation_count || 0,
        h_index: result.h_index || 0,
        external_ids: result.external_ids
      })) || [],
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    return extractedData;
  }

  if ('query' in parsedContent && 'results' in parsedContent) {
    return {
      query: parsedContent.query || null,
      total_results: parsedContent.total_available || parsedContent.total_results || 0,
      total_available: parsedContent.total_available,
      results_returned: parsedContent.results_returned,
      results: parsedContent.results?.map((result: any) => ({
        rank: result.rank || 0,
        author_id: result.author_id || '',
        name: result.name || '',
        url: result.url || '',
        affiliations: result.affiliations || [],
        homepage: result.homepage,
        paper_count: result.paper_count || 0,
        citation_count: result.citation_count || 0,
        h_index: result.h_index || 0,
        external_ids: result.external_ids
      })) || [],
      success: true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {
    query: null,
    total_results: 0,
    results: [],
    success: undefined,
    timestamp: undefined
  };
};

const extractFromLegacyFormat = (content: any): Omit<AuthorSearchData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    return {
      query: toolData.query || args.query || null,
      total_results: 0,
      results: []
    };
  }

  return {
    query: null,
    total_results: 0,
    results: []
  };
};

export function extractAuthorSearchData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  query: string | null;
  total_results: number;
  results: AuthorSearchResult[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: AuthorSearchData = {
    query: null,
    total_results: 0,
    results: []
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.query || assistantNewFormat.results.length > 0) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.query || toolNewFormat.results.length > 0) {
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
      query: assistantLegacy.query || toolLegacy.query,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    query: data.query,
    total_results: data.total_results,
    results: data.results,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}
