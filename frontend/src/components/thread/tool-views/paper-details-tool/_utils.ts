import { ToolCallData, ToolResultData } from '../types';

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

export function extractPaperDetailsData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  paper: PaperDetails | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let paper: PaperDetails | null = null;

  if (toolResult?.output) {
    const output = toolResult.output;
    let parsedOutput: any = {};
    
    if (typeof output === 'string') {
      try {
        parsedOutput = JSON.parse(output);
      } catch (e) {
        // Not JSON, keep empty
      }
    } else if (typeof output === 'object' && output !== null) {
      parsedOutput = output;
    }

    paper = parsedOutput.paper || null;
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    paper,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}

