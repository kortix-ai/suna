import { ToolCallData, ToolResultData } from '../types';

/**
 * Extract web search data from structured metadata props
 * NO CONTENT PARSING - uses toolCall.arguments and toolResult.output directly
 */
export function extractWebSearchData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  query: string | null;
  searchResults: Array<{ title: string; url: string; snippet?: string }>;
  answer: string | null;
  images: string[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
  isBatch?: boolean;
  batchResults?: Array<{
    query: string;
    success: boolean;
    results: Array<{ title: string; url: string; snippet?: string }>;
    answer: string;
    images: string[];
  }>;
} {
  // Default return value - ensures function ALWAYS returns
  const defaultReturn = {
    query: null,
    searchResults: [],
    answer: null,
    images: [],
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    isBatch: false,
    batchResults: undefined
  };

  try {
    // Defensive check - ensure toolCall is defined
    if (!toolCall) {
      return defaultReturn;
    }

    // Extract query from toolCall.arguments (from metadata)
    const args = toolCall.arguments || {};
    const query: string | null = args.query || null;

    // Extract output from toolResult.output (from metadata)
    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;
    
    if (toolResult?.output) {
      output = toolResult.output;
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
    }

    // Parse output to extract results, answer, images
    let searchResults: Array<{ title: string; url: string; snippet?: string }> = [];
    let answer: string | null = null;
    let images: string[] = [];
    let isBatch = false;
    let batchResults: Array<{
      query: string;
      success: boolean;
      results: Array<{ title: string; url: string; snippet?: string }>;
      answer: string;
      images: string[];
    }> | undefined = undefined;

    if (output && typeof output === 'object' && output !== null) {
      // Handle image_search batch_results format (batch_results array without batch_mode flag)
      if (output.batch_results && Array.isArray(output.batch_results) && !output.batch_mode) {
        isBatch = true;
        batchResults = output.batch_results.map((batchItem: any) => ({
          query: batchItem.query || '',
          success: batchItem.success !== false,
          results: [], // image_search doesn't have text results
          answer: '',
          images: Array.isArray(batchItem.images) ? batchItem.images.map((img: any) => 
            typeof img === 'string' ? img : img.url || ''
          ).filter(Boolean) : []
        }));

        // Flatten all images for combined display
        const allImages = batchResults.flatMap(br => br.images);
        const allQueries = batchResults.map(br => br.query).filter(Boolean);
        const combinedQuery = allQueries.length > 1 
          ? `${allQueries.length} queries: ${allQueries.join(', ')}` 
          : allQueries[0] || query;
        const allSuccessful = batchResults.every(br => br.success);

        return {
          query: combinedQuery || query,
          searchResults: [],
          answer: null,
          images: allImages,
          actualIsSuccess: allSuccessful,
          actualToolTimestamp,
          actualAssistantTimestamp: assistantTimestamp,
          isBatch: true,
          batchResults
        };
      }

      // Handle web_search batch mode (batch_mode flag with results array)
      if (output.batch_mode === true && Array.isArray(output.results)) {
        isBatch = true;
        batchResults = output.results.map((batchItem: any) => ({
          query: batchItem.query || '',
          success: batchItem.success !== false,
          results: (batchItem.results || []).map((result: any) => ({
            title: result.title || '',
            url: result.url || '',
            snippet: result.content || result.snippet || ''
          })),
          answer: batchItem.answer || '',
          images: Array.isArray(batchItem.images) ? batchItem.images.map((img: any) => 
            typeof img === 'string' ? img : img.url || ''
          ).filter(Boolean) : []
        }));

        // Flatten for combined display
        const allResults = batchResults.flatMap(br => br.results);
        const allImages = batchResults.flatMap(br => br.images);
        const allQueries = batchResults.map(br => br.query).filter(Boolean);
        const combinedQuery = allQueries.length > 1 
          ? `${allQueries.length} queries: ${allQueries.join(', ')}` 
          : allQueries[0] || query;
        const allSuccessful = batchResults.every(br => br.success);

        return {
          query: combinedQuery || query,
          searchResults: allResults,
          answer: batchResults.map(br => br.answer).filter(Boolean).join('\n\n') || null,
          images: allImages,
          actualIsSuccess: allSuccessful,
          actualToolTimestamp,
          actualAssistantTimestamp: assistantTimestamp,
          isBatch: true,
          batchResults
        };
      }

      // Handle single search result
      // Extract results array
      if (Array.isArray(output.results)) {
        searchResults = output.results.map((result: any) => ({
          title: result.title || '',
          url: result.url || '',
          snippet: result.content || result.snippet || ''
        }));
      } else if (Array.isArray(output)) {
        searchResults = output.map((result: any) => ({
          title: result.title || '',
          url: result.url || '',
          snippet: result.content || result.snippet || ''
        }));
      }
        
      // Extract answer
      answer = output.answer || output.summary || null;

      // Extract images (for single result mode)
      if (Array.isArray(output.images)) {
        images = output.images.map((img: any) => 
          typeof img === 'string' ? img : img.url || ''
        ).filter(Boolean);
      }
    } else if (typeof output === 'string') {
      // Handle string output - try to parse as JSON
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && parsed !== null) {
          if (Array.isArray(parsed.results)) {
            searchResults = parsed.results.map((result: any) => ({
              title: result.title || '',
              url: result.url || '',
              snippet: result.content || result.snippet || ''
            }));
          }
          answer = parsed.answer || parsed.summary || null;
          if (Array.isArray(parsed.images)) {
            images = parsed.images.map((img: any) => 
              typeof img === 'string' ? img : img.url || ''
            ).filter(Boolean);
          }
        }
      } catch (e) {
        // Not JSON, treat as answer text
        answer = output;
      }
    }

    return {
      query,
      searchResults,
      answer,
      images,
      actualIsSuccess,
      actualToolTimestamp,
      actualAssistantTimestamp: assistantTimestamp,
      isBatch,
      batchResults
    };
  } catch (error) {
    // Catch any errors and return default values
    console.error('extractWebSearchData error:', error);
    return defaultReturn;
  }
} 
