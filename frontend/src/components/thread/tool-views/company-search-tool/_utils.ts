import { ToolCallData, ToolResultData } from '../types';

export interface CompanySearchResult {
  rank: number;
  id: string;
  webset_id: string;
  source: string;
  source_id: string;
  url: string;
  type: string;
  description: string;
  company_name: string;
  company_location: string;
  company_industry: string;
  company_logo_url: string;
  evaluations: string;
  enrichment_data: string;
  created_at: string;
  updated_at: string;
}

export interface CompanySearchData {
  query: string | null;
  total_results: number;
  cost_deducted: string;
  enrichment_type: string;
  results: CompanySearchResult[];
  success?: boolean;
  timestamp?: string;
}


export function extractCompanySearchData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  query: string | null;
  total_results: number;
  cost_deducted: string;
  enrichment_type: string;
  results: CompanySearchResult[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  const query = args.query || null;
  const enrichment_type = args.enrichment_description || '';
  
  let total_results = 0;
  let cost_deducted = '$0.54';
  let results: CompanySearchResult[] = [];

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

    total_results = parsedOutput.total_results || 0;
    cost_deducted = parsedOutput.cost_deducted || '$0.54';
    results = parsedOutput.results?.map((result: any) => ({
      rank: result.rank || 0,
      id: result.id || '',
      webset_id: result.webset_id || '',
      source: result.source || '',
      source_id: result.source_id || '',
      url: result.url || '',
      type: result.type || 'company',
      description: result.description || '',
      company_name: result.company_name || '',
      company_location: result.company_location || '',
      company_industry: result.company_industry || '',
      company_logo_url: result.company_logo_url || '',
      evaluations: result.evaluations || '',
      enrichment_data: result.enrichment_data || '',
      created_at: result.created_at || '',
      updated_at: result.updated_at || ''
    })) || [];
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    query,
    total_results,
    cost_deducted,
    enrichment_type,
    results,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
