import type { ToolCallData, ToolResultData } from '../types';

export interface RealityDefenderIndicator {
  name: string;
  score: number;
  description: string;
}

export interface RealityDefenderData {
  filePath: string | null;
  mediaType: string | null;
  isDeepfake: boolean;
  confidence: number;
  verdict: string | null;
  indicators: RealityDefenderIndicator[];
  analysisId: string | null;
  success: boolean;
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

export function extractRealityDefenderData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true
): RealityDefenderData {
  // Parse arguments
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    }
  }

  const filePath: string | null = args.file_path || null;

  // Parse output
  let output: any = null;
  let success = isSuccess;

  if (toolResult?.output) {
    output = parseContent(toolResult.output);
    if (toolResult.success !== undefined) {
      success = toolResult.success;
    }
  }

  // Extract detection results
  let mediaType: string | null = null;
  let isDeepfake = false;
  let confidence = 0;
  let verdict: string | null = null;
  let indicators: RealityDefenderIndicator[] = [];
  let analysisId: string | null = null;

  if (output && typeof output === 'object' && output !== null) {
    mediaType = output.media_type || output.mediaType || null;
    isDeepfake = output.is_deepfake === true || output.isDeepfake === true;
    confidence = typeof output.confidence === 'number' ? output.confidence : 0;
    verdict = output.verdict || null;

    if (Array.isArray(output.indicators)) {
      indicators = output.indicators.map((indicator: any) => ({
        name: indicator.name || 'unknown',
        score: typeof indicator.score === 'number' ? indicator.score : 0,
        description: indicator.description || indicator.explanation || '',
      }));
    }

    analysisId = output.analysis_id || output.analysisId || null;
  }

  return {
    filePath,
    mediaType,
    isDeepfake,
    confidence,
    verdict,
    indicators,
    analysisId,
    success,
  };
}
