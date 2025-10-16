import { extractToolData } from '../utils';

export interface PaperSearchResult {
  rank: number;
  id?: string;
  paper_id?: string;
  webset_id?: string;
  source?: string;
  source_id?: string;
  url: string;
  type?: string;
  description?: string;
  title?: string;
  abstract?: string;
  year?: number;
  authors?: Array<{ name: string; author_id: string }>;
  venue?: string;
  venue_type?: string;
  citation_count?: number;
  reference_count?: number;
  influential_citation_count?: number;
  is_open_access?: boolean;
  pdf_url?: string | null;
  fields_of_study?: string[];
  publication_types?: string[];
  publication_date?: string;
  journal?: string;
  paper_details?: string;
  evaluations?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PaperSearchData {
  query: string | null;
  total_results: number;
  total_available?: number;
  results_returned?: number;
  enrichment_type?: string;
  results: PaperSearchResult[];
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

const extractFromNewFormat = (content: any): PaperSearchData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      query: null, 
      total_results: 0, 
      enrichment_type: '',
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
      enrichment_type: args.enrichment_description || parsedOutput?.enrichment_type,
      results: parsedOutput?.results?.map((result: any) => ({
        rank: result.rank || 0,
        id: result.id || result.paper_id || '',
        paper_id: result.paper_id,
        webset_id: result.webset_id,
        source: result.source,
        source_id: result.source_id,
        url: result.url || '',
        type: result.type || 'paper',
        description: result.description || result.title || '',
        title: result.title,
        abstract: result.abstract,
        year: result.year,
        authors: result.authors,
        venue: result.venue,
        venue_type: result.venue_type,
        citation_count: result.citation_count,
        reference_count: result.reference_count,
        influential_citation_count: result.influential_citation_count,
        is_open_access: result.is_open_access,
        pdf_url: result.pdf_url,
        fields_of_study: result.fields_of_study,
        publication_types: result.publication_types,
        publication_date: result.publication_date,
        journal: result.journal,
        paper_details: result.paper_details || result.abstract,
        evaluations: result.evaluations,
        created_at: result.created_at,
        updated_at: result.updated_at
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
      enrichment_type: parsedContent.enrichment_type,
      results: parsedContent.results?.map((result: any) => ({
        rank: result.rank || 0,
        id: result.id || result.paper_id || '',
        paper_id: result.paper_id,
        webset_id: result.webset_id,
        source: result.source,
        source_id: result.source_id,
        url: result.url || '',
        type: result.type || 'paper',
        description: result.description || result.title || '',
        title: result.title,
        abstract: result.abstract,
        year: result.year,
        authors: result.authors,
        venue: result.venue,
        venue_type: result.venue_type,
        citation_count: result.citation_count,
        reference_count: result.reference_count,
        influential_citation_count: result.influential_citation_count,
        is_open_access: result.is_open_access,
        pdf_url: result.pdf_url,
        fields_of_study: result.fields_of_study,
        publication_types: result.publication_types,
        publication_date: result.publication_date,
        journal: result.journal,
        paper_details: result.paper_details || result.abstract,
        evaluations: result.evaluations,
        created_at: result.created_at,
        updated_at: result.updated_at
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
    enrichment_type: '',
    results: [], 
    success: undefined, 
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<PaperSearchData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    return {
      query: toolData.query || args.query || null,
      total_results: 0,
      enrichment_type: args.enrichment_description || '',
      results: []
    };
  }

  return {
    query: null,
    total_results: 0,
    enrichment_type: '',
    results: []
  };
};

export function extractPaperSearchData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  query: string | null;
  total_results: number;
  enrichment_type: string;
  results: PaperSearchResult[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: PaperSearchData = {
    query: null,
    total_results: 0,
    enrichment_type: '',
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
    enrichment_type: data.enrichment_type,
    results: data.results,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}
