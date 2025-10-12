import { extractToolData } from '../utils';

export interface AuthorPaper {
  rank: number;
  paper_id: string;
  title: string;
  abstract?: string;
  year?: number;
  url: string;
  venue?: string;
  venue_type?: string;
  citation_count: number;
  reference_count: number;
  influential_citation_count: number;
  is_open_access: boolean;
  pdf_url?: string | null;
  fields_of_study?: string[];
  publication_types?: string[];
  publication_date?: string;
  journal?: string;
}

export interface AuthorPapersData {
  author_id: string | null;
  papers_returned: number;
  offset?: number;
  next_offset?: number | null;
  has_more?: boolean;
  papers: AuthorPaper[];
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

const extractFromNewFormat = (content: any): AuthorPapersData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {
      author_id: null,
      papers_returned: 0,
      papers: [],
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
      author_id: args.author_id || parsedOutput?.author_id || null,
      papers_returned: parsedOutput?.papers_returned || 0,
      offset: parsedOutput?.offset,
      next_offset: parsedOutput?.next_offset,
      has_more: parsedOutput?.has_more,
      papers: parsedOutput?.papers?.map((paper: any) => ({
        rank: paper.rank || 0,
        paper_id: paper.paper_id || '',
        title: paper.title || '',
        abstract: paper.abstract,
        year: paper.year,
        url: paper.url || '',
        venue: paper.venue,
        venue_type: paper.venue_type,
        citation_count: paper.citation_count || 0,
        reference_count: paper.reference_count || 0,
        influential_citation_count: paper.influential_citation_count || 0,
        is_open_access: paper.is_open_access || false,
        pdf_url: paper.pdf_url,
        fields_of_study: paper.fields_of_study,
        publication_types: paper.publication_types,
        publication_date: paper.publication_date,
        journal: paper.journal
      })) || [],
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    return extractedData;
  }

  if ('author_id' in parsedContent && 'papers' in parsedContent) {
    return {
      author_id: parsedContent.author_id || null,
      papers_returned: parsedContent.papers_returned || parsedContent.papers?.length || 0,
      offset: parsedContent.offset,
      next_offset: parsedContent.next_offset,
      has_more: parsedContent.has_more,
      papers: parsedContent.papers?.map((paper: any) => ({
        rank: paper.rank || 0,
        paper_id: paper.paper_id || '',
        title: paper.title || '',
        abstract: paper.abstract,
        year: paper.year,
        url: paper.url || '',
        venue: paper.venue,
        venue_type: paper.venue_type,
        citation_count: paper.citation_count || 0,
        reference_count: paper.reference_count || 0,
        influential_citation_count: paper.influential_citation_count || 0,
        is_open_access: paper.is_open_access || false,
        pdf_url: paper.pdf_url,
        fields_of_study: paper.fields_of_study,
        publication_types: paper.publication_types,
        publication_date: paper.publication_date,
        journal: paper.journal
      })) || [],
      success: true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {
    author_id: null,
    papers_returned: 0,
    papers: [],
    success: undefined,
    timestamp: undefined
  };
};

const extractFromLegacyFormat = (content: any): Omit<AuthorPapersData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    return {
      author_id: null,
      papers_returned: 0,
      papers: []
    };
  }

  return {
    author_id: null,
    papers_returned: 0,
    papers: []
  };
};

export function extractAuthorPapersData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  author_id: string | null;
  papers_returned: number;
  has_more: boolean;
  papers: AuthorPaper[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: AuthorPapersData = {
    author_id: null,
    papers_returned: 0,
    papers: []
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.author_id || assistantNewFormat.papers.length > 0) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.author_id || toolNewFormat.papers.length > 0) {
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
      author_id: assistantLegacy.author_id || toolLegacy.author_id,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    author_id: data.author_id,
    papers_returned: data.papers_returned,
    has_more: data.has_more || false,
    papers: data.papers,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}

