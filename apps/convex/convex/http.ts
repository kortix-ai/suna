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
import { api } from "./_generated/api";
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
    const thread = await ctx.runMutation(api.internal.createThread, {
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
    const threads = await ctx.runQuery(api.internal.listThreadsByAccount, {
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
  const threadId = extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  try {
    const thread = await ctx.runQuery(api.internal.getThread, { threadId });

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
    const thread = await ctx.runMutation(api.internal.updateThread, {
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
    const result = await ctx.runMutation(api.internal.deleteThread, { threadId });
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

  const url = new URL(request.url);
  const threadId = extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  // Validate required fields
  if (!body.messageId) {
    return errorResponse("MISSING_FIELD", 400, "messageId is required");
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
    const message = await ctx.runMutation(api.internal.addMessage, {
      messageId: body.messageId,
      threadId,
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
  const threadId = extractIdFromPath(url.pathname, "threads");

  if (!threadId) {
    return errorResponse("MISSING_ID", 400, "Thread ID is required");
  }

  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  try {
    const messages = await ctx.runQuery(api.internal.getMessagesByThread, {
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
  if (!body.id) {
    return errorResponse("MISSING_FIELD", 400, "id is required");
  }
  if (!body.threadId) {
    return errorResponse("MISSING_FIELD", 400, "threadId is required");
  }

  try {
    const run = await ctx.runMutation(api.internal.createAgentRun, {
      id: body.id,
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
  const id = extractIdFromPath(url.pathname, "agent-runs");

  if (!id) {
    return errorResponse("MISSING_ID", 400, "Agent run ID is required");
  }

  try {
    const run = await ctx.runQuery(api.internal.getAgentRun, { id });

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

  const url = new URL(request.url);
  const id = extractIdFromPath(url.pathname, "agent-runs");

  if (!id) {
    return errorResponse("MISSING_ID", 400, "Agent run ID is required");
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse("INVALID_BODY", 400, "Request body must be valid JSON");
  }

  try {
    const run = await ctx.runMutation(api.internal.updateAgentRun, {
      id,
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

  try {
    const memory = await ctx.runMutation(api.internal.storeMemory, {
      memorySpaceId: body.memorySpaceId,
      participantId: body.participantId,
      content: body.content,
      contentType: body.contentType || "raw",
      embedding: body.embedding,
      sourceType: body.sourceType || "system",
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
    const memories = await ctx.runQuery(api.internal.searchMemoriesInternal, {
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
  const memorySpaceId = extractIdFromPath(url.pathname, "memories");

  if (!memorySpaceId) {
    return errorResponse("MISSING_ID", 400, "Memory space ID is required");
  }

  const limit = url.searchParams.get("limit");

  try {
    const memories = await ctx.runQuery(api.internal.getMemoriesBySpace, {
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

  try {
    const fact = await ctx.runMutation(api.internal.storeFact, {
      memorySpaceId: body.memorySpaceId,
      participantId: body.participantId,
      userId: body.userId,
      fact: body.fact,
      factType: body.factType || "knowledge",
      subject: body.subject,
      predicate: body.predicate,
      object: body.object,
      confidence: body.confidence ?? 80,
      sourceType: body.sourceType || "system",
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
  const memorySpaceId = extractIdFromPath(url.pathname, "facts");

  if (!memorySpaceId) {
    return errorResponse("MISSING_ID", 400, "Memory space ID is required");
  }

  const limit = url.searchParams.get("limit");

  try {
    const facts = await ctx.runQuery(api.internal.getFactsBySpace, {
      memorySpaceId,
      limit: limit ? parseInt(limit) : 100,
    });

    return jsonResponse(facts);
  } catch (error: any) {
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
    const agent = await ctx.runMutation(api.internal.createAgent, {
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
    const agents = await ctx.runQuery(api.internal.getAgentsByAccount, { accountId });
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
    const agent = await ctx.runMutation(api.internal.updateAgent, {
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
    const trigger = await ctx.runMutation(api.internal.createTrigger, {
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
    const triggers = await ctx.runQuery(api.internal.getTriggersByAgent, { agentId });
    return jsonResponse(triggers);
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
  path: "/api/agents/update",
  method: "PATCH",
  handler: updateAgent,
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

export default http;
