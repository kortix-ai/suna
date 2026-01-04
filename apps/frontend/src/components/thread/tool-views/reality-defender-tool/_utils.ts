import { ToolCallData, ToolResultData } from '../types';

export interface RealityDefenderIndicator {
  name: string;
  score: number;
  description: string;
}

/**
 * Extract Reality Defender deepfake detection data from structured metadata props
 * NO CONTENT PARSING - uses toolCall.arguments and toolResult.output directly
 */
export function extractRealityDefenderData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  filePath: string | null;
  mediaType: string | null;
  isDeepfake: boolean;
  confidence: number;
  verdict: string | null;
  indicators: RealityDefenderIndicator[];
  analysisId: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Default return value - ensures function ALWAYS returns
  const defaultReturn = {
    filePath: null,
    mediaType: null,
    isDeepfake: false,
    confidence: 0,
    verdict: null,
    indicators: [],
    analysisId: null,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };

  try {
    // Defensive check - ensure toolCall is defined
    if (!toolCall) {
      return defaultReturn;
    }

    // Extract file_path from toolCall.arguments (from metadata)
    const args = toolCall.arguments || {};
    const filePath: string | null = args.file_path || null;

    // Extract output from toolResult.output (from metadata)
    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;
    
    if (toolResult?.output) {
      output = toolResult.output;
      if (toolResult?.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
    }

    // Parse output to extract detection results
    let mediaType: string | null = null;
    let isDeepfake = false;
    let confidence = 0;
    let verdict: string | null = null;
    let indicators: RealityDefenderIndicator[] = [];
    let analysisId: string | null = null;

    if (output && typeof output === 'object' && output !== null) {
      // Extract fields from output object
      mediaType = output.media_type || output.mediaType || null;
      isDeepfake = output.is_deepfake === true || output.isDeepfake === true;
      confidence = typeof output.confidence === 'number' ? output.confidence : 0;
      verdict = output.verdict || null;
      
      // Extract indicators
      if (Array.isArray(output.indicators)) {
        indicators = output.indicators.map((indicator: any) => ({
          name: indicator.name || 'unknown',
          score: typeof indicator.score === 'number' ? indicator.score : 0,
          description: indicator.description || indicator.explanation || '',
        }));
      }
      
      // Extract analysis ID if available
      analysisId = output.analysis_id || output.analysisId || null;
    } else if (typeof output === 'string') {
      // Handle string output - try to parse as JSON
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && parsed !== null) {
          mediaType = parsed.media_type || parsed.mediaType || null;
          isDeepfake = parsed.is_deepfake === true || parsed.isDeepfake === true;
          confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
          verdict = parsed.verdict || null;
          
          if (Array.isArray(parsed.indicators)) {
            indicators = parsed.indicators.map((indicator: any) => ({
              name: indicator.name || 'unknown',
              score: typeof indicator.score === 'number' ? indicator.score : 0,
              description: indicator.description || indicator.explanation || '',
            }));
          }
          
          analysisId = parsed.analysis_id || parsed.analysisId || null;
        }
      } catch (e) {
        // Not JSON, can't extract structured data
        console.warn('Failed to parse Reality Defender output as JSON:', e);
      }
    }

    return {
      filePath,
      mediaType,
      isDeepfake,
      confidence,
      verdict,
      indicators,
      analysisId,
      actualIsSuccess,
      actualToolTimestamp,
      actualAssistantTimestamp: assistantTimestamp,
    };
  } catch (error) {
    // Catch any errors and return default values
    console.error('extractRealityDefenderData error:', error);
    return defaultReturn;
  }
}
