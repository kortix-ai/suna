import { ToolCallData, ToolResultData } from '../types';

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
  inputSchema?: any; // Full input schema from build endpoint (contains title, description, properties, etc.)
  input_schema?: any; // Fallback for snake_case
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
  // All other fields from API response
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
  // Legacy fields (deprecated - results always saved to disk now)
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
    console.error('extractApifySearchData error:', error);
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
      if (toolResult.success !== undefined) {
        actualIsSuccess = toolResult.success;
      }
      if (toolResult.timestamp) {
        actualToolTimestamp = toolResult.timestamp;
      }
    }

    if (output && typeof output === 'object' && output !== null) {
      // Full response structure: all actor details + inputSchema
      const inputSchema = output.inputSchema || output.input_schema;
      const imageUrl = output.imageUrl || output.image_url || output.pictureUrl;
      
      // Extract title/description - prefer from actor details, fallback to inputSchema
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
        input_schema: inputSchema, // Keep both for compatibility
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
        // Include all other fields from API response
        ...output,
        actualIsSuccess,
        actualToolTimestamp,
        actualAssistantTimestamp: assistantTimestamp,
      };
    }

    return defaultReturn;
  } catch (error) {
    console.error('extractApifyActorDetails error:', error);
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
    console.error('extractApifyRunData error:', error);
    return defaultReturn;
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
        saved_to_disk: output.saved_to_disk ?? true, // Default to true - results always saved to disk now
        file_path: output.file_path,
        item_count: output.item_count || output.count || 0,
        message: output.message,
        // Legacy fields for backward compatibility
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
    console.error('extractApifyRunResultsData error:', error);
    return defaultReturn;
  }
}
