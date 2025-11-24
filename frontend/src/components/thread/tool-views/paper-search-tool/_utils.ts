import { ToolCallData, ToolResultData } from '../types';

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


export function extractPaperSearchData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
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
  const args = toolCall.arguments || {};
  const query = args.query || null;
  const enrichment_type = args.enrichment_description || '';
  
  let total_results = 0;
  let results: PaperSearchResult[] = [];

  // Extract from toolResult output
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

    total_results = parsedOutput.total_available || parsedOutput.total_results || 0;
    results = parsedOutput.results?.map((result: any) => ({
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
    })) || [];
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    query,
    total_results,
    enrichment_type,
    results,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
