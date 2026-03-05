/**
 * Kortix Suna - HTTP Actions for Python Backend Integration
 *
 * This file provides HTTP routes for the Python FastAPI backend to interact
 * with the Convex database. It handles:
 * - Thread management
 * - Message operations
 * - Agent runs
 * - Agent configurations
 * - Triggers
 * - Cortex Memory SDK (memories, facts)
 *
 * Authentication: Bearer token via Authorization header
 */

import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { httpRouter } from "convex/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES & HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ErrorResponse {
  error: string;
  message?: string;
  status: number;
}

/**
 * Create a JSON response with proper headers
 */
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Account-Id",
    },
  });
}

/**
 * Create an error response
 */
function errorResponse(error: string, status = 400, message?: string): Response {
  const body: ErrorResponse = { error, status };
  if (message) body.message = message;
  return jsonResponse(body, status);
}

/**
 * Parse JSON body from request
 */
async function parseJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Validate Authorization header (Bearer token)
 * In production, this should validate against a real auth system
 */
function validateAuth(request: Request): { valid: boolean; accountId?: string } {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return { valid: false };
  }

  if (!authHeader.startsWith("Bearer ")) {
    return { valid: false };
  }

  const token = authHeader.substring(7);

  // In production, validate the token properly
  // For now, we accept any non-empty token and extract account from a custom header
  // or use a default for development
  if (!token || token.length === 0) {
    return { valid: false };
  }

  // Get account ID from custom header or use token as identifier
  const accountId = request.headers.get("X-Account-Id") || token;

  return { valid: true, accountId };
}

/**
 * Handle CORS preflight requests
 */
function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Account-Id",
    },
  });
}

/**
 * Extract ID from URL path
 * Expected pattern: /api/resource/:id or /api/resource/:id/subresource
 */
function extractIdFromPath(url: string, resourceName: string): string | null {
  const parts = url.split("/");
  const resourceIndex = parts.indexOf(resourceName);
  if (resourceIndex === -1 || resourceIndex + 1 >= parts.length) {
    return null;
  }
  return parts[resourceIndex + 1] || null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THREAD ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/threads - Create thread
 */
export const createThread = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.threadId) {
    return errorResponse("MISSING_FIELD", 400, "threadId is required");
  }

  try {
    const thread = await ctx.runMutation(internal.internal.createThread, {
      threadId: body.threadId,
      accountId: body.accountId || auth.accountId!,
      projectId: body.projectId,
      agentId: body.agentId,
      isPublic: body.isPublic ?? false,
      metadata: body.metadata,
    });

    return jsonResponse(thread, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/threads - List threads by account
 */
export const listThreads = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") || auth.accountId!;
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  try {
    const threads = await ctx.runQuery(internal.internal.listThreadsByAccount, {
      accountId,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });

    return jsonResponse(threads);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/threads/:id - Get thread
 */
export const getThread = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const threadId = url.searchParams.get("id") || extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  try {
    const thread = await ctx.runQuery(internal.internal.getThread, { threadId });

    if (!thread) {
      return errorResponse("NOT_FOUND", 404, "Thread not found");
    }

    return jsonResponse(thread);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * PATCH /api/threads/:id - Update thread
 */
export const updateThread = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const threadId = extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  try {
    const thread = await ctx.runMutation(internal.internal.updateThread, {
      threadId,
      projectId: body.projectId,
      agentId: body.agentId,
      isPublic: body.isPublic,
      metadata: body.metadata,
    });

    return jsonResponse(thread);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Thread not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * DELETE /api/threads/:id - Delete thread
 */
export const deleteThread = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const threadId = extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  try {
    const result = await ctx.runMutation(internal.internal.deleteThread, { threadId });
    return jsonResponse(result);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Thread not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MESSAGE ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/threads/:id/messages - Add message
 */
export const addMessage = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.messageId) {
    return errorResponse("MISSING_FIELD", 400, "messageId is required");
  }
  if (!body.threadId) {
    return errorResponse("MISSING_FIELD", 400, "threadId is required");
  }
  if (!body.type) {
    return errorResponse("MISSING_FIELD", 400, "type is required");
  }
  if (body.isLlmMessage === undefined) {
    return errorResponse("MISSING_FIELD", 400, "isLlmMessage is required");
  }
  if (body.content === undefined) {
    return errorResponse("MISSING_FIELD", 400, "content is required");
  }

  try {
    const message = await ctx.runMutation(internal.internal.addMessage, {
      messageId: body.messageId,
      threadId: body.threadId,
      type: body.type,
      isLlmMessage: body.isLlmMessage,
      content: body.content,
      agentId: body.agentId,
      metadata: body.metadata,
    });

    return jsonResponse(message, 201);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Thread not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/threads/:id/messages - Get messages
 */
export const getMessages = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "threadId query parameter is required");
  }

  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  try {
    const messages = await ctx.runQuery(internal.internal.getMessagesByThread, {
      threadId,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });

    return jsonResponse(messages);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT RUN ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/agent-runs - Create agent run
 */
export const createAgentRun = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.runId) {
    return errorResponse("MISSING_FIELD", 400, "runId is required");
  }
  if (!body.threadId) {
    return errorResponse("MISSING_FIELD", 400, "threadId is required");
  }

  try {
    const run = await ctx.runMutation(internal.internal.createAgentRun, {
      runId: body.runId,
      threadId: body.threadId,
      status: body.status || "queued",
      metadata: body.metadata,
    });

    return jsonResponse(run, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/agent-runs/:id - Get agent run
 */
export const getAgentRun = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id") || extractIdFromPath(url.pathname, "agent-runs");

  if (!id) {
    return errorResponse("MISSING_ID", 400, "Agent run ID is required");
  }

  try {
    const run = await ctx.runQuery(internal.internal.getAgentRun, { runId: id });

    if (!run) {
      return errorResponse("NOT_FOUND", 404, "Agent run not found");
    }

    return jsonResponse(run);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * PATCH /api/agent-runs/:id - Update agent run status
 */
export const updateAgentRun = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.runId) {
    return errorResponse("MISSING_FIELD", 400, "runId is required in request body");
  }

  try {
    const run = await ctx.runMutation(internal.internal.updateAgentRun, {
      runId: body.runId,
      status: body.status,
      completedAt: body.completedAt,
      error: body.error,
      metadata: body.metadata,
    });

    return jsonResponse(run);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Agent run not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/agent-runs/count - Count active agent runs (running + queued)
 */
export const countActiveAgentRuns = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  try {
    const count = await ctx.runQuery(internal.internal.countActiveAgentRuns, {});
    return jsonResponse({ count });
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY ROUTES (Cortex Memory SDK)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/memories - Store memory
 */
export const storeMemory = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.memorySpaceId) {
    return errorResponse("MISSING_FIELD", 400, "memorySpaceId is required");
  }
  if (!body.content) {
    return errorResponse("MISSING_FIELD", 400, "content is required");
  }

  // Validate sourceType if provided
  const validSourceTypes = ["conversation", "system", "tool", "a2a", "fact-extraction"];
  const sourceType = body.sourceType || "system";
  if (!validSourceTypes.includes(sourceType)) {
    return errorResponse(
      "INVALID_SOURCE_TYPE",
      400,
      `sourceType must be one of: ${validSourceTypes.join(", ")}. Received: "${sourceType}"`
    );
  }

  // Auto-generate memoryId if not provided
  const memoryId = body.memoryId || `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const memory = await ctx.runMutation(internal.internal.storeMemory, {
      memoryId,
      memorySpaceId: body.memorySpaceId,
      participantId: body.participantId,
      content: body.content,
      contentType: body.contentType || "raw",
      embedding: body.embedding,
      sourceType,
      sourceUserId: body.sourceUserId,
      sourceUserName: body.sourceUserName,
      userId: body.userId,
      agentId: body.agentId,
      messageRole: body.messageRole,
      enrichedContent: body.enrichedContent,
      factCategory: body.factCategory,
      conversationRef: body.conversationRef,
      importance: body.importance ?? 50,
      tags: body.tags || [],
      metadata: body.metadata,
    });

    return jsonResponse(memory, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * POST /api/memories/search - Search memories
 */
export const searchMemories = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.memorySpaceId) {
    return errorResponse("MISSING_FIELD", 400, "memorySpaceId is required");
  }
  if (!body.query) {
    return errorResponse("MISSING_FIELD", 400, "query is required");
  }

  try {
    const memories = await ctx.runQuery(internal.internal.searchMemoriesInternal, {
      memorySpaceId: body.memorySpaceId,
      query: body.query,
      embedding: body.embedding,
      limit: body.limit,
    });

    return jsonResponse(memories);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/memories/:memorySpaceId - Get memories by space
 */
export const getMemoriesBySpace = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const memorySpaceId = url.searchParams.get("memorySpaceId") || extractIdFromPath(url.pathname, "memories");

  if (!memorySpaceId) {
    return errorResponse("MISSING_ID", 400, "Memory space ID is required");
  }

  const limit = url.searchParams.get("limit");

  try {
    const memories = await ctx.runQuery(internal.internal.getMemoriesBySpace, {
      memorySpaceId,
      limit: limit ? parseInt(limit) : 100,
    });

    return jsonResponse(memories);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FACT ROUTES (Cortex Memory SDK)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/facts - Store fact
 */
export const storeFact = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.memorySpaceId) {
    return errorResponse("MISSING_FIELD", 400, "memorySpaceId is required");
  }
  if (!body.fact) {
    return errorResponse("MISSING_FIELD", 400, "fact is required");
  }

  // Validate sourceType if provided (facts have slightly different valid values than memories)
  const validFactSourceTypes = ["conversation", "system", "tool", "manual", "a2a"];
  const factSourceType = body.sourceType || "system";
  if (!validFactSourceTypes.includes(factSourceType)) {
    return errorResponse(
      "INVALID_SOURCE_TYPE",
      400,
      `sourceType must be one of: ${validFactSourceTypes.join(", ")}. Received: "${factSourceType}"`
    );
  }

  // Auto-generate factId if not provided
  const factId = body.factId || `fact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const fact = await ctx.runMutation(internal.internal.storeFact, {
      factId,
      memorySpaceId: body.memorySpaceId,
      participantId: body.participantId,
      userId: body.userId,
      fact: body.fact,
      factType: body.factType || "knowledge",
      subject: body.subject,
      predicate: body.predicate,
      object: body.object,
      confidence: body.confidence ?? 80,
      sourceType: factSourceType,
      tags: body.tags || [],
      category: body.category,
      metadata: body.metadata,
    });

    return jsonResponse(fact, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/facts/:memorySpaceId - Get facts by space
 */
export const getFactsBySpace = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const memorySpaceId = url.searchParams.get("memorySpaceId") || extractIdFromPath(url.pathname, "facts");

  if (!memorySpaceId) {
    return errorResponse("MISSING_ID", 400, "Memory space ID is required");
  }

  const limit = url.searchParams.get("limit");

  try {
    const facts = await ctx.runQuery(internal.internal.getFactsBySpace, {
      memorySpaceId,
      limit: limit ? parseInt(limit) : 100,
    });

    return jsonResponse(facts);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USER ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * GET /api/users/get - Get user by ID
 */
export const getUser = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || auth.accountId;

  if (!userId) {
    return errorResponse("MISSING_ID", 400, "userId is required");
  }

  try {
    const user = await ctx.runQuery(internal.internal.getUser, { userId });
    return jsonResponse(user);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "User not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/agents - Create agent
 */
export const createAgent = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.agentId) {
    return errorResponse("MISSING_FIELD", 400, "agentId is required");
  }
  if (!body.name) {
    return errorResponse("MISSING_FIELD", 400, "name is required");
  }

  try {
    const agent = await ctx.runMutation(internal.internal.createAgent, {
      agentId: body.agentId,
      accountId: body.accountId || auth.accountId!,
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      configuredMcps: body.configuredMcps,
      customMcps: body.customMcps,
      agentpressTools: body.agentpressTools,
      isDefault: body.isDefault ?? false,
      avatar: body.avatar,
      avatarColor: body.avatarColor,
      iconName: body.iconName,
      metadata: body.metadata,
      tags: body.tags,
    });

    return jsonResponse(agent, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/agents/:accountId - Get agents by account
 */
export const getAgentsByAccount = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const accountId = extractIdFromPath(url.pathname, "agents");

  if (!accountId) {
    return errorResponse("MISSING_ID", 400, "Account ID is required");
  }

  try {
    const agents = await ctx.runQuery(internal.internal.getAgentsByAccount, { accountId });
    return jsonResponse(agents);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * PATCH /api/agents/:id - Update agent
 */
export const updateAgent = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const agentId = extractIdFromPath(url.pathname, "agents");

  if (!agentId) {
    return errorResponse("MISSING_ID", 400, "Agent ID is required");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  try {
    const agent = await ctx.runMutation(internal.internal.updateAgent, {
      agentId,
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      configuredMcps: body.configuredMcps,
      customMcps: body.customMcps,
      agentpressTools: body.agentpressTools,
      isDefault: body.isDefault,
      avatar: body.avatar,
      avatarColor: body.avatarColor,
      iconName: body.iconName,
      metadata: body.metadata,
      tags: body.tags,
    });

    return jsonResponse(agent);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Agent not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/agents/get - Get agent by ID
 */
export const getAgent = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const agentId = url.searchParams.get("id");

  if (!agentId) {
    return errorResponse("MISSING_ID", 400, "Agent ID is required");
  }

  try {
    const agent = await ctx.runQuery(internal.internal.getAgent, { agentId });

    if (!agent) {
      return errorResponse("NOT_FOUND", 404, "Agent not found");
    }

    return jsonResponse(agent);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Agent not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * DELETE /api/agents/delete - Delete agent
 */
export const deleteAgent = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body || !body.agentId) {
    return errorResponse("MISSING_ID", 400, "Agent ID is required in request body");
  }

  try {
    const result = await ctx.runMutation(internal.internal.deleteAgent, {
      agentId: body.agentId,
    });

    return jsonResponse(result);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Agent not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * POST /api/agents/clear-default - Clear default agents for account
 */
export const clearDefaultAgents = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body || !body.accountId) {
    return errorResponse("MISSING_ID", 400, "Account ID is required in request body");
  }

  try {
    const result = await ctx.runMutation(internal.internal.clearDefaultAgents, {
      accountId: body.accountId,
    });

    return jsonResponse(result);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRIGGER ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/triggers - Create trigger
 */
export const createTrigger = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.triggerId) {
    return errorResponse("MISSING_FIELD", 400, "triggerId is required");
  }
  if (!body.agentId) {
    return errorResponse("MISSING_FIELD", 400, "agentId is required");
  }
  if (!body.triggerType) {
    return errorResponse("MISSING_FIELD", 400, "triggerType is required");
  }
  if (!body.name) {
    return errorResponse("MISSING_FIELD", 400, "name is required");
  }

  try {
    const trigger = await ctx.runMutation(internal.internal.createTrigger, {
      triggerId: body.triggerId,
      agentId: body.agentId,
      triggerType: body.triggerType,
      name: body.name,
      description: body.description,
      isActive: body.isActive ?? true,
      config: body.config,
    });

    return jsonResponse(trigger, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/triggers/:agentId - Get triggers by agent
 */
export const getTriggersByAgent = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const agentId = extractIdFromPath(url.pathname, "triggers");

  if (!agentId) {
    return errorResponse("MISSING_ID", 400, "Agent ID is required");
  }

  try {
    const triggers = await ctx.runQuery(internal.internal.getTriggersByAgent, { agentId });
    return jsonResponse(triggers);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KNOWLEDGE BASE FOLDER ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/kb/folders - Create knowledge base folder
 */
export const createKBFolder = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.folderId) {
    return errorResponse("MISSING_FIELD", 400, "folderId is required");
  }
  if (!body.name) {
    return errorResponse("MISSING_FIELD", 400, "name is required");
  }

  try {
    const folder = await ctx.runMutation(internal.internal.createKnowledgeBaseFolder, {
      folderId: body.folderId,
      accountId: body.accountId || auth.accountId!,
      name: body.name,
      description: body.description,
    });

    return jsonResponse(folder, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/folders - List knowledge base folders
 */
export const listKBFolders = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") || auth.accountId!;

  try {
    const folders = await ctx.runQuery(internal.internal.listKnowledgeBaseFolders, {
      accountId,
    });

    // Add entry count to each folder
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder: any) => {
        const count = await ctx.runQuery(internal.internal.getKnowledgeBaseEntryCountByFolder, {
          folderId: folder.folderId,
        });
        return {
          ...folder,
          entryCount: count,
        };
      })
    );

    return jsonResponse(foldersWithCounts);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/folders/get - Get knowledge base folder
 */
export const getKBFolder = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");

  if (!folderId) {
    return errorResponse("MISSING_ID", 400, "folderId is required");
  }

  try {
    const folder = await ctx.runQuery(internal.internal.getKnowledgeBaseFolder, { folderId });
    return jsonResponse(folder);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Folder not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * PATCH /api/kb/folders/update - Update knowledge base folder
 */
export const updateKBFolder = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.folderId) {
    return errorResponse("MISSING_FIELD", 400, "folderId is required in request body");
  }

  try {
    const folder = await ctx.runMutation(internal.internal.updateKnowledgeBaseFolder, {
      folderId: body.folderId,
      name: body.name,
      description: body.description,
    });

    return jsonResponse(folder);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Folder not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * DELETE /api/kb/folders/delete - Delete knowledge base folder
 */
export const deleteKBFolder = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body || !body.folderId) {
    return errorResponse("MISSING_ID", 400, "folderId is required in request body");
  }

  try {
    const result = await ctx.runMutation(internal.internal.deleteKnowledgeBaseFolder, {
      folderId: body.folderId,
    });
    return jsonResponse(result);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Folder not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KNOWLEDGE BASE ENTRY ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/kb/entries - Create knowledge base entry
 */
export const createKBEntry = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.entryId) return errorResponse("MISSING_FIELD", 400, "entryId is required");
  if (!body.folderId) return errorResponse("MISSING_FIELD", 400, "folderId is required");
  if (!body.filename) return errorResponse("MISSING_FIELD", 400, "filename is required");
  if (body.fileSize === undefined) return errorResponse("MISSING_FIELD", 400, "fileSize is required");
  if (!body.storagePath) return errorResponse("MISSING_FIELD", 400, "storagePath is required");

  try {
    const entry = await ctx.runMutation(internal.internal.createKnowledgeBaseEntry, {
      entryId: body.entryId,
      accountId: body.accountId || auth.accountId!,
      folderId: body.folderId,
      filename: body.filename,
      fileType: body.fileType,
      fileSize: body.fileSize,
      storagePath: body.storagePath,
      summary: body.summary,
      status: body.status,
    });

    return jsonResponse(entry, 201);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/entries - List knowledge base entries
 */
export const listKBEntries = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") || auth.accountId!;
  const folderId = url.searchParams.get("folderId");
  const activeOnly = url.searchParams.get("activeOnly") !== "false";

  try {
    const entries = await ctx.runQuery(internal.internal.listKnowledgeBaseEntries, {
      accountId,
      folderId: folderId || undefined,
      activeOnly,
    });

    return jsonResponse(entries);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/entries/get - Get knowledge base entry
 */
export const getKBEntry = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");

  if (!entryId) {
    return errorResponse("MISSING_ID", 400, "entryId is required");
  }

  try {
    const entry = await ctx.runQuery(internal.internal.getKnowledgeBaseEntry, { entryId });
    return jsonResponse(entry);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Entry not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * PATCH /api/kb/entries/update - Update knowledge base entry
 */
export const updateKBEntry = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.entryId) {
    return errorResponse("MISSING_FIELD", 400, "entryId is required in request body");
  }

  try {
    const entry = await ctx.runMutation(internal.internal.updateKnowledgeBaseEntry, {
      entryId: body.entryId,
      folderId: body.folderId,
      filename: body.filename,
      summary: body.summary,
      status: body.status,
      processingError: body.processingError,
      isActive: body.isActive,
    });

    return jsonResponse(entry);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Entry not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * DELETE /api/kb/entries/delete - Delete knowledge base entry
 */
export const deleteKBEntry = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body || !body.entryId) {
    return errorResponse("MISSING_ID", 400, "entryId is required in request body");
  }

  try {
    const result = await ctx.runMutation(internal.internal.deleteKnowledgeBaseEntry, {
      entryId: body.entryId,
    });
    return jsonResponse(result);
  } catch (error: any) {
    if (error.message?.includes("NOT_FOUND")) {
      return errorResponse("NOT_FOUND", 404, "Entry not found");
    }
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/entries/total-size - Get total file size for account
 */
export const getKBTotalSize = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") || auth.accountId!;

  try {
    const totalSize = await ctx.runQuery(internal.internal.getKnowledgeBaseTotalFileSize, {
      accountId,
    });

    return jsonResponse({ totalSize });
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT KNOWLEDGE ENTRY ASSIGNMENT ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * GET /api/kb/agent-assignments - Get agent's knowledge entry assignments
 */
export const getKBAgentAssignments = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return errorResponse("MISSING_ID", 400, "agentId is required");
  }

  try {
    const assignments = await ctx.runQuery(internal.internal.listAgentKnowledgeEntryAssignments, {
      agentId,
    });

    // Group by folder
    const folderMap: Record<string, string[]> = {};
    for (const assignment of assignments) {
      // Get the entry to find its folder
      try {
        const entry = await ctx.runQuery(internal.internal.getKnowledgeBaseEntry, {
          entryId: assignment.entryId,
        });
        if (entry && entry.folderId) {
          if (!folderMap[entry.folderId]) {
            folderMap[entry.folderId] = [];
          }
          folderMap[entry.folderId].push(assignment.entryId);
        }
      } catch {
        // Entry might be deleted, skip
      }
    }

    return jsonResponse({ folders: folderMap });
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * POST /api/kb/agent-assignments/update - Update agent's knowledge entry assignments
 */
export const updateKBAgentAssignments = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  if (!body.agentId) {
    return errorResponse("MISSING_FIELD", 400, "agentId is required");
  }

  try {
    const result = await ctx.runMutation(internal.internal.updateAgentKnowledgeEntryAssignments, {
      agentId: body.agentId,
      accountId: body.accountId || auth.accountId!,
      folderIds: body.folderIds || [],
    });

    return jsonResponse(result);
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

/**
 * GET /api/kb/agent-assignments/by-entry - Get agent IDs for an entry
 */
export const getKBAgentsByEntry = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleCors();

  const auth = validateAuth(request);
  if (!auth.valid) {
    return errorResponse("UNAUTHORIZED", 401, "Missing or invalid Authorization header");
  }

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");

  if (!entryId) {
    return errorResponse("MISSING_ID", 400, "entryId is required");
  }

  try {
    const agentIds = await ctx.runQuery(internal.internal.listAgentIdsByEntry, { entryId });
    return jsonResponse({ agentIds });
  } catch (error: any) {
    return errorResponse("INTERNAL_ERROR", 500, error.message);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTER SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const http = httpRouter();

// Thread routes
http.route({
  path: "/api/threads",
  method: "POST",
  handler: createThread,
});
http.route({
  path: "/api/threads",
  method: "GET",
  handler: listThreads,
});
http.route({
  path: "/api/threads/get",
  method: "GET",
  handler: getThread,
});
http.route({
  path: "/api/threads/update",
  method: "PATCH",
  handler: updateThread,
});
http.route({
  path: "/api/threads/delete",
  method: "DELETE",
  handler: deleteThread,
});

// Message routes
http.route({
  path: "/api/threads/messages/add",
  method: "POST",
  handler: addMessage,
});
http.route({
  path: "/api/threads/messages",
  method: "GET",
  handler: getMessages,
});

// Agent run routes
http.route({
  path: "/api/agent-runs",
  method: "POST",
  handler: createAgentRun,
});
http.route({
  path: "/api/agent-runs/get",
  method: "GET",
  handler: getAgentRun,
});
http.route({
  path: "/api/agent-runs/update",
  method: "PATCH",
  handler: updateAgentRun,
});
http.route({
  path: "/api/agent-runs/count",
  method: "GET",
  handler: countActiveAgentRuns,
});

// Memory routes
http.route({
  path: "/api/memories",
  method: "POST",
  handler: storeMemory,
});
http.route({
  path: "/api/memories/search",
  method: "POST",
  handler: searchMemories,
});
http.route({
  path: "/api/memories/list",
  method: "GET",
  handler: getMemoriesBySpace,
});

// Fact routes
http.route({
  path: "/api/facts",
  method: "POST",
  handler: storeFact,
});
http.route({
  path: "/api/facts/list",
  method: "GET",
  handler: getFactsBySpace,
});

// User routes
http.route({
  path: "/api/users/get",
  method: "GET",
  handler: getUser,
});

// Agent routes
http.route({
  path: "/api/agents",
  method: "POST",
  handler: createAgent,
});
http.route({
  path: "/api/agents/list",
  method: "GET",
  handler: getAgentsByAccount,
});
http.route({
  path: "/api/agents/get",
  method: "GET",
  handler: getAgent,
});
http.route({
  path: "/api/agents/update",
  method: "PATCH",
  handler: updateAgent,
});
http.route({
  path: "/api/agents/delete",
  method: "DELETE",
  handler: deleteAgent,
});
http.route({
  path: "/api/agents/clear-default",
  method: "POST",
  handler: clearDefaultAgents,
});

// Trigger routes
http.route({
  path: "/api/triggers",
  method: "POST",
  handler: createTrigger,
});
http.route({
  path: "/api/triggers/list",
  method: "GET",
  handler: getTriggersByAgent,
});

// Knowledge Base Folder routes
http.route({
  path: "/api/kb/folders",
  method: "POST",
  handler: createKBFolder,
});
http.route({
  path: "/api/kb/folders",
  method: "GET",
  handler: listKBFolders,
});
http.route({
  path: "/api/kb/folders/get",
  method: "GET",
  handler: getKBFolder,
});
http.route({
  path: "/api/kb/folders/update",
  method: "PATCH",
  handler: updateKBFolder,
});
http.route({
  path: "/api/kb/folders/delete",
  method: "DELETE",
  handler: deleteKBFolder,
});

// Knowledge Base Entry routes
http.route({
  path: "/api/kb/entries",
  method: "POST",
  handler: createKBEntry,
});
http.route({
  path: "/api/kb/entries",
  method: "GET",
  handler: listKBEntries,
});
http.route({
  path: "/api/kb/entries/get",
  method: "GET",
  handler: getKBEntry,
});
http.route({
  path: "/api/kb/entries/update",
  method: "PATCH",
  handler: updateKBEntry,
});
http.route({
  path: "/api/kb/entries/delete",
  method: "DELETE",
  handler: deleteKBEntry,
});
http.route({
  path: "/api/kb/entries/total-size",
  method: "GET",
  handler: getKBTotalSize,
});

// Agent Knowledge Entry Assignment routes
http.route({
  path: "/api/kb/agent-assignments",
  method: "GET",
  handler: getKBAgentAssignments,
});
http.route({
  path: "/api/kb/agent-assignments/update",
  method: "POST",
  handler: updateKBAgentAssignments,
});
http.route({
  path: "/api/kb/agent-assignments/by-entry",
  method: "GET",
  handler: getKBAgentsByEntry,
});

export default http;
