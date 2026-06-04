import { ToolCallData, ToolResultData } from '../types';
import { log } from '@/lib/logger';

export interface ApifyActor {
  actor_id: string;
  name: string;
  title: string;
  username: string;
  description: string;
  pricing_model?: string;
  run_count: number;
  is_featured: boolean;
  is_premium: boolean;
}

export interface ApifyActorDetails {
  actor_id?: string;
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  username?: string;
  userId?: string;
  imageUrl?: string;
  pictureUrl?: string;
  inputSchema?: any;
  input_schema?: any;
  stats?: {
    totalRuns?: number;
    totalUsers?: number;
    totalBuilds?: number;
    bookmarkCount?: number;
    totalUsers7Days?: number;
    actorReviewCount?: number;
    lastRunStartedAt?: string;
    totalUsers30Days?: number;
    totalUsers90Days?: number;
    actorReviewRating?: number;
    publicActorRunStats30Days?: {
      TOTAL?: number;
      FAILED?: number;
      ABORTED?: number;
      SUCCEEDED?: number;
      "TIMED-OUT"?: number;
    };
  };
  pricingInfos?: Array<{
    unitName?: string;
    createdAt?: string;
    startedAt?: string;
    pricingModel?: string;
    pricePerUnitUsd?: number;
    apifyMarginPercentage?: number;
    reasonForChange?: string;
    isPriceChangeNotificationSuppressed?: boolean;
  }>;
  categories?: string[];
  taggedBuilds?: {
    latest?: {
      buildId?: string;
      finishedAt?: string;
      buildNumber?: string;
      buildNumberInt?: number;
    };
  };
  createdAt?: string;
  modifiedAt?: string;
  isPublic?: boolean;
  isGeneric?: boolean;
  isCritical?: boolean;
  isDeprecated?: boolean;
  hasNoDataset?: boolean;
  [key: string]: any;
}

export interface ApifyRunResult {
  run_id: string;
  actor_id: string;
  status: string;
  cost_usd: number;
  cost_with_markup_usd: number;
  cost_deducted: string;
  results: any[];
  result_count: number;
  total_items: number;
  has_more: boolean;
  dataset_id?: string;
  saved_to_disk?: boolean;
  file_path?: string;
  message?: string;
}

export interface ApifySearchData {
  actors: ApifyActor[];
  total: number;
  query: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
}

export interface ApifyRunResultsData {
  run_id: string;
  actor_id?: string;
  dataset_id: string;
  saved_to_disk: boolean;
  file_path?: string;
  item_count: number;
  message?: string;
  items: any[];
  count: number;
  offset: number;
  limit: number;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
}

export function extractApifySearchData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ApifySearchData {
  const defaultReturn: ApifySearchData = {
    actors: [],
    total: 0,
    query: '',
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };

  try {
    if (!toolCall) {
      return defaultReturn;
    }

    const args = toolCall.arguments || {};
    const query: string = args.query || '';

    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;

    if (toolResult?.output) {
      output = toolResult.output;
      // Parse JSON string if needed
      if (typeof output === 'string') {
        try {
          output = JSON.parse(output);
        } catch {
          // If parsing fails, keep as string
        }
      }
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      return {
        query,
        actors: output.actors || [],
        total: output.total || 0,
        actualIsSuccess,
        actualToolTimestamp,
        actualAssistantTimestamp: assistantTimestamp,
      };
    }

    return defaultReturn;
  } catch (error) {
    log.error('extractApifySearchData error:', error);
    return defaultReturn;
  }
}

export function extractApifyActorDetails(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ApifyActorDetails & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultReturn = {
    actor_id: '',
    name: '',
    title: '',
    description: '',
    username: '',
    imageUrl: undefined,
    inputSchema: undefined,
    input_schema: undefined,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };

  try {
    if (!toolCall) {
      return defaultReturn;
    }

    const args = toolCall.arguments || {};
    const actor_id: string = args.actor_id || '';

    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;

    if (toolResult?.output) {
      output = toolResult.output;
      // Parse JSON string if needed
      if (typeof output === 'string') {
        try {
          output = JSON.parse(output);
        } catch {
          // If parsing fails, keep as string
        }
      }
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      const inputSchema = output.inputSchema || output.input_schema;
      const imageUrl = output.imageUrl || output.image_url || output.pictureUrl;
      
      const title = output.title || inputSchema?.title || output.name || '';
      const description = output.description || inputSchema?.description || '';
      
      return {
        actor_id: output.actor_id || output.id || actor_id,
        id: output.id || output.actor_id,
        name: output.name || title,
        title: title,
        description: description,
        username: output.username,
        userId: output.userId,
        imageUrl: imageUrl,
        pictureUrl: output.pictureUrl || imageUrl,
        inputSchema: inputSchema,
        input_schema: inputSchema,
        stats: output.stats,
        pricingInfos: output.pricingInfos,
        categories: output.categories,
        taggedBuilds: output.taggedBuilds,
        createdAt: output.createdAt,
        modifiedAt: output.modifiedAt,
        isPublic: output.isPublic,
        isGeneric: output.isGeneric,
        isCritical: output.isCritical,
        isDeprecated: output.isDeprecated,
        hasNoDataset: output.hasNoDataset,
        ...output,
        actualIsSuccess,
        actualToolTimestamp,
        actualAssistantTimestamp: assistantTimestamp,
      };
    }

    return defaultReturn;
  } catch (error) {
    log.error('extractApifyActorDetails error:', error);
    return defaultReturn;
  }
}

export function extractApifyRunData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ApifyRunResult & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
  run_input?: any;
} {
  const defaultReturn = {
    run_id: '',
    actor_id: '',
    status: '',
    cost_usd: 0,
    cost_with_markup_usd: 0,
    cost_deducted: '',
    results: [],
    result_count: 0,
    total_items: 0,
    has_more: false,
    dataset_id: undefined,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    run_input: undefined,
  };

  try {
    if (!toolCall) {
      return defaultReturn;
    }

    const args = toolCall.arguments || {};
    const run_input = args.run_input;

    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;

    if (toolResult?.output) {
      output = toolResult.output;
      // Parse JSON string if needed
      if (typeof output === 'string') {
        try {
          output = JSON.parse(output);
        } catch {
          // If parsing fails, keep as string
        }
      }
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      return {
        run_id: output.run_id || '',
        actor_id: output.actor_id || '',
        status: output.status || '',
        cost_usd: output.cost_usd || 0,
        cost_with_markup_usd: output.cost_with_markup_usd || 0,
        cost_deducted: output.cost_deducted || '',
        results: output.results || [],
        result_count: output.result_count || 0,
        total_items: output.total_items || 0,
        has_more: output.has_more || false,
        dataset_id: output.dataset_id,
        saved_to_disk: output.saved_to_disk || false,
        file_path: output.file_path,
        message: output.message,
        actualIsSuccess,
        actualToolTimestamp,
        actualAssistantTimestamp: assistantTimestamp,
        run_input,
      };
    }

    return defaultReturn;
  } catch (error) {
    log.error('extractApifyRunData error:', error);
    return defaultReturn;
  }
}

export interface ApifyApprovalData {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  actor_id: string;
  estimated_cost_usd?: number;
  estimated_cost_credits?: number;
  max_cost_usd?: number;
  actual_cost_usd?: number;
  actual_cost_credits?: number;
  run_id?: string;
  created_at?: string;
  approved_at?: string;
  expires_at?: string;
  message?: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
}

export function extractApifyApprovalData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ApifyApprovalData | null {
  try {
    if (!toolCall) {
      return null;
    }

    const functionName = toolCall.function_name || '';
    
    // Only extract if it's an approval-related function
    if (!functionName.includes('approval') && !functionName.includes('request_apify_approval') && !functionName.includes('approve_apify_request')) {
      return null;
    }

    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;

    if (toolResult?.output) {
      output = toolResult.output;
      // Parse JSON string if needed
      if (typeof output === 'string') {
        try {
          output = JSON.parse(output);
        } catch {
          // If parsing fails, keep as string
        }
      }
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      if (output.approval_id) {
        return {
          approval_id: output.approval_id,
          status: output.status || 'pending',
          actor_id: output.actor_id || '',
          estimated_cost_usd: output.estimated_cost_usd,
          estimated_cost_credits: output.estimated_cost_credits,
          max_cost_usd: output.max_cost_usd,
          actual_cost_usd: output.actual_cost_usd,
          actual_cost_credits: output.actual_cost_credits,
          run_id: output.run_id,
          created_at: output.created_at,
          approved_at: output.approved_at,
          expires_at: output.expires_at,
          message: output.message,
          actualIsSuccess,
          actualToolTimestamp,
          actualAssistantTimestamp: assistantTimestamp,
        };
      }
    }

    return null;
  } catch (error) {
    log.error('extractApifyApprovalData error:', error);
    return null;
  }
}

export function extractApifyRunResultsData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ApifyRunResultsData {
  const defaultReturn: ApifyRunResultsData = {
    run_id: '',
    dataset_id: '',
    saved_to_disk: false,
    file_path: undefined,
    item_count: 0,
    message: undefined,
    items: [],
    count: 0,
    offset: 0,
    limit: 0,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };

  try {
    if (!toolCall) {
      return defaultReturn;
    }

    const args = toolCall.arguments || {};
    const run_id: string = args.run_id || '';

    let output: any = null;
    let actualIsSuccess = isSuccess;
    let actualToolTimestamp = toolTimestamp;

    if (toolResult?.output) {
      output = toolResult.output;
      // Parse JSON string if needed
      if (typeof output === 'string') {
        try {
          output = JSON.parse(output);
        } catch {
          // If parsing fails, keep as string
        }
      }
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      return {
        run_id: output.run_id || run_id,
        actor_id: output.actor_id,
        dataset_id: output.dataset_id || '',
        saved_to_disk: output.saved_to_disk ?? true,
        file_path: output.file_path,
        item_count: output.item_count || output.count || 0,
        message: output.message,
        items: output.items || [],
        count: output.item_count || output.count || 0,
        offset: output.offset || 0,
        limit: output.limit || 0,
        actualIsSuccess,
        actualToolTimestamp,
        actualAssistantTimestamp: assistantTimestamp,
      };
    }

    return defaultReturn;
  } catch (error) {
    log.error('extractApifyRunResultsData error:', error);
    return defaultReturn;
  }
}

