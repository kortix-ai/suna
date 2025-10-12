import { extractToolData } from '../utils';

export interface Author {
  author_id: string;
  name: string;
  url?: string;
  affiliations?: string[];
  homepage?: string;
  paper_count?: number;
  citation_count?: number;
  h_index?: number;
}

export interface CitationReference {
  paper_id: string;
  title: string;
  year?: number;
  authors: string[];
  citation_count: number;
}

export interface PaperDetails {
  paper_id: string;
  corpus_id?: number;
  title: string;
  abstract?: string | null;
  tldr?: string | null;
  year?: number;
  url: string;
  authors: Author[];
  venue?: string;
  venue_name?: string;
  venue_type?: string;
  citation_count: number;
  reference_count: number;
  influential_citation_count: number;
  is_open_access: boolean;
  pdf_info?: {
    url: string;
    status: string;
    license: string;
  } | null;
  fields_of_study?: string[] | null;
  publication_types?: string[];
  publication_date?: string;
  journal?: string;
  external_ids?: Record<string, any>;
  citation_styles?: {
    bibtex?: string;
  };
  citations?: CitationReference[] | null;
  references?: CitationReference[] | null;
}

export interface PaperDetailsData {
  paper: PaperDetails | null;
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

const extractFromNewFormat = (content: any): PaperDetailsData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {
      paper: null,
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
      paper: parsedOutput.paper || null,
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
          paper: parsedOutput.paper || null,
          success: parsedContent.success,
          timestamp: undefined
        };
      } catch (e) {
      }
    }
    return {
      paper: output.paper || null,
      success: parsedContent.success,
      timestamp: undefined
    };
  }

  if ('paper' in parsedContent) {
    return {
      paper: parsedContent.paper || null,
      success: parsedContent.success !== undefined ? parsedContent.success : true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {
    paper: null,
    success: undefined,
    timestamp: undefined
  };
};

const extractFromLegacyFormat = (content: any): Omit<PaperDetailsData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    return {
      paper: null
    };
  }

  return {
    paper: null
  };
};

export function extractPaperDetailsData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  paper: PaperDetails | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: PaperDetailsData = {
    paper: null
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.paper) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.paper) {
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
      paper: assistantLegacy.paper || toolLegacy.paper,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    paper: data.paper,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}

