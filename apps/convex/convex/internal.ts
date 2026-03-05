/**
 * Kortix Suna - Internal Functions for Python Backend Integration
 *
 * These functions are called by HTTP actions to perform database operations.
 */

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════════════
// USER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const getUser = internalQuery({
  args: { userId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("id"), args.userId))
      .first();

    if (!user) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User not found" });
    }

    return user;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// THREAD OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createThread = internalMutation({
  args: {
    threadId: v.string(),
    accountId: v.string(),
    projectId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    isPublic: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      threadId: args.threadId,
      accountId: args.accountId,
      projectId: args.projectId,
      agentId: args.agentId,
      isPublic: args.isPublic ?? false,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(threadId);
  },
});

export const getThread = internalQuery({
  args: { threadId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!thread) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Thread not found" });
    }
    return thread;
  },
});

export const listThreads = internalQuery({
  args: {
    accountId: v.string(),
    projectId: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    
    let query = ctx.db
      .query("threads")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId));

    if (args.projectId) {
      query = query.filter((q) => q.eq(q.field("projectId"), args.projectId));
    }

    // Apply offset by skipping records
    const allResults = await query.order("desc").collect();
    return allResults.slice(offset, offset + limit);
  },
});

// Alias for http.ts compatibility
export const listThreadsByAccount = listThreads;

export const updateThread = internalMutation({
  args: {
    threadId: v.string(),
    projectId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    isPublic: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Thread not found" });
    }

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.projectId !== undefined) updates.projectId = args.projectId;
    if (args.agentId !== undefined) updates.agentId = args.agentId;
    if (args.isPublic !== undefined) updates.isPublic = args.isPublic;
    if (args.metadata !== undefined) updates.metadata = args.metadata;

    await ctx.db.patch(thread._id, updates);
    return await ctx.db.get(thread._id);
  },
});

export const deleteThread = internalMutation({
  args: { threadId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Thread not found" });
    }

    // Delete all messages in thread
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }

    // Delete all agent runs in thread
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    for (const run of runs) {
      await ctx.db.delete(run._id);
    }

    await ctx.db.delete(thread._id);
    return true;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const addMessage = internalMutation({
  args: {
    messageId: v.string(),
    threadId: v.string(),
    type: v.string(),
    content: v.any(),
    isLlmMessage: v.optional(v.boolean()),
    agentId: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      messageId: args.messageId,
      threadId: args.threadId,
      type: args.type,
      content: args.content,
      isLlmMessage: args.isLlmMessage ?? true,
      agentId: args.agentId,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(messageId);
  },
});

export const getMessages = internalQuery({
  args: {
    threadId: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    isLlmOnly: v.optional(v.boolean()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;

    let messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();

    if (args.isLlmOnly) {
      messages = messages.filter((m) => m.isLlmMessage);
    }

    return messages.slice(offset, offset + limit);
  },
});

// Alias for http.ts compatibility
export const getMessagesByThread = getMessages;

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT RUN OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createAgentRun = internalMutation({
  args: {
    runId: v.string(),
    threadId: v.string(),
    status: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", {
      runId: args.runId,
      threadId: args.threadId,
      status: args.status || "queued",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      metadata: args.metadata,
    });
    return await ctx.db.get(runId);
  },
});

export const getAgentRun = internalQuery({
  args: { runId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("agentRuns")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!run) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agent run not found" });
    }
    return run;
  },
});

export const updateAgentRun = internalMutation({
  args: {
    runId: v.string(),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("agentRuns")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();

    if (!run) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agent run not found" });
    }

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.status !== undefined) updates.status = args.status;
    if (args.error !== undefined) updates.error = args.error;
    if (args.completedAt !== undefined) updates.completedAt = args.completedAt;
    if (args.metadata !== undefined) updates.metadata = args.metadata;

    await ctx.db.patch(run._id, updates);
    return await ctx.db.get(run._id);
  },
});

export const countActiveAgentRuns = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx, _args) => {
    // Count runs with status 'running' or 'queued'
    const runningRuns = await ctx.db
      .query("agentRuns")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    const queuedRuns = await ctx.db
      .query("agentRuns")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();

    return runningRuns.length + queuedRuns.length;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const getAgent = internalQuery({
  args: { agentId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("appAgents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();
    if (!agent) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agent not found" });
    }
    return agent;
  },
});

export const listAgents = internalQuery({
  args: { accountId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("appAgents")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .collect();
  },
});

// Alias for http.ts compatibility
export const getAgentsByAccount = listAgents;

export const createAgent = internalMutation({
  args: {
    agentId: v.string(),
    accountId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.string(),
    configuredMcps: v.optional(v.any()),
    customMcps: v.optional(v.any()),
    agentpressTools: v.optional(v.any()),
    isDefault: v.optional(v.boolean()),
    avatar: v.optional(v.string()),
    avatarColor: v.optional(v.string()),
    iconName: v.optional(v.string()),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const agentId = await ctx.db.insert("appAgents", {
      agentId: args.agentId,
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      systemPrompt: args.systemPrompt,
      configuredMcps: args.configuredMcps ?? [],
      customMcps: args.customMcps ?? [],
      agentpressTools: args.agentpressTools ?? {},
      isDefault: args.isDefault ?? false,
      avatar: args.avatar,
      avatarColor: args.avatarColor,
      iconName: args.iconName,
      metadata: args.metadata,
      tags: args.tags,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(agentId);
  },
});

export const updateAgent = internalMutation({
  args: {
    agentId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    configuredMcps: v.optional(v.any()),
    customMcps: v.optional(v.any()),
    agentpressTools: v.optional(v.any()),
    isDefault: v.optional(v.boolean()),
    avatar: v.optional(v.string()),
    avatarColor: v.optional(v.string()),
    iconName: v.optional(v.string()),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("appAgents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    if (!agent) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agent not found" });
    }

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.systemPrompt !== undefined) updates.systemPrompt = args.systemPrompt;
    if (args.configuredMcps !== undefined) updates.configuredMcps = args.configuredMcps;
    if (args.customMcps !== undefined) updates.customMcps = args.customMcps;
    if (args.agentpressTools !== undefined) updates.agentpressTools = args.agentpressTools;
    if (args.isDefault !== undefined) updates.isDefault = args.isDefault;
    if (args.avatar !== undefined) updates.avatar = args.avatar;
    if (args.avatarColor !== undefined) updates.avatarColor = args.avatarColor;
    if (args.iconName !== undefined) updates.iconName = args.iconName;
    if (args.metadata !== undefined) updates.metadata = args.metadata;
    if (args.tags !== undefined) updates.tags = args.tags;

    await ctx.db.patch(agent._id, updates);
    return await ctx.db.get(agent._id);
  },
});

export const deleteAgent = internalMutation({
  args: { agentId: v.string() },
  returns: v.object({ success: v.boolean(), agentId: v.string() }),
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("appAgents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();
    if (!agent) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agent not found" });
    }
    await ctx.db.delete(agent._id);
    return { success: true, agentId: args.agentId };
  },
});

export const clearDefaultAgents = internalMutation({
  args: { accountId: v.string() },
  returns: v.object({ success: v.boolean(), count: v.number() }),
  handler: async (ctx, args) => {
    const agents = await ctx.db
      .query("appAgents")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .filter((q) => q.eq(q.field("isDefault"), true))
      .collect();

    for (const agent of agents) {
      await ctx.db.patch(agent._id, { isDefault: false });
    }
    return { success: true, count: agents.length };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createTrigger = internalMutation({
  args: {
    triggerId: v.string(),
    agentId: v.string(),
    triggerType: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    config: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const triggerId = await ctx.db.insert("agentTriggers", {
      triggerId: args.triggerId,
      agentId: args.agentId,
      triggerType: args.triggerType,
      name: args.name,
      description: args.description,
      isActive: args.isActive ?? true,
      config: args.config ?? {},
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(triggerId);
  },
});

export const listTriggers = internalQuery({
  args: { agentId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentTriggers")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .collect();
  },
});

// Alias for http.ts compatibility
export const getTriggersByAgent = listTriggers;

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY OPERATIONS (Cortex SDK)
// ═══════════════════════════════════════════════════════════════════════════════

export const storeMemory = internalMutation({
  args: {
    memoryId: v.string(),
    memorySpaceId: v.string(),
    participantId: v.optional(v.string()),
    content: v.string(),
    contentType: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    sourceType: v.string(),
    sourceUserId: v.optional(v.string()),
    sourceUserName: v.optional(v.string()),
    userId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    messageRole: v.optional(v.string()),
    enrichedContent: v.optional(v.string()),
    factCategory: v.optional(v.string()),
    conversationRef: v.optional(v.any()),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const memoryId = await ctx.db.insert("memories", {
      memoryId: args.memoryId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      content: args.content,
      contentType: (args.contentType ?? "raw") as "raw" | "summarized" | "fact",
      embedding: args.embedding,
      sourceType: args.sourceType as any,
      sourceUserId: args.sourceUserId,
      sourceUserName: args.sourceUserName,
      messageRole: args.messageRole as any,
      enrichedContent: args.enrichedContent,
      factCategory: args.factCategory,
      conversationRef: args.conversationRef,
      importance: args.importance ?? 50,
      tags: args.tags ?? [],
      metadata: args.metadata,
      sourceTimestamp: now,
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });
    return await ctx.db.get(memoryId);
  },
});

export const searchMemories = internalQuery({
  args: {
    memorySpaceId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const memories = await ctx.db
      .query("memories")
      .withSearchIndex("by_content", (q) =>
        q.search("content", args.query).eq("memorySpaceId", args.memorySpaceId)
      )
      .take(limit);
    return memories;
  },
});

// Extended search for http.ts with embedding support
export const searchMemoriesInternal = internalQuery({
  args: {
    memorySpaceId: v.string(),
    query: v.string(),
    embedding: v.optional(v.array(v.float64())),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    // If embedding provided, could use vector search
    // For now, use text search
    const memories = await ctx.db
      .query("memories")
      .withSearchIndex("by_content", (q) =>
        q.search("content", args.query).eq("memorySpaceId", args.memorySpaceId)
      )
      .take(limit);
    return memories;
  },
});

export const listMemories = internalQuery({
  args: {
    memorySpaceId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) => q.eq("memorySpaceId", args.memorySpaceId))
      .order("desc")
      .take(limit);
  },
});

// Alias for http.ts compatibility
export const getMemoriesBySpace = listMemories;

// ═══════════════════════════════════════════════════════════════════════════════
// FACT OPERATIONS (Cortex SDK)
// ═══════════════════════════════════════════════════════════════════════════════

export const storeFact = internalMutation({
  args: {
    factId: v.string(),
    memorySpaceId: v.string(),
    participantId: v.optional(v.string()),
    userId: v.optional(v.string()),
    fact: v.string(),
    factType: v.string(),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    confidence: v.optional(v.number()),
    sourceType: v.optional(v.string()),
    category: v.optional(v.string()),
    searchAliases: v.optional(v.array(v.string())),
    semanticContext: v.optional(v.string()),
    entities: v.optional(v.any()),
    relations: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const factId = await ctx.db.insert("facts", {
      factId: args.factId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      userId: args.userId,
      fact: args.fact,
      factType: args.factType as any,
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      confidence: args.confidence ?? 80,
      sourceType: (args.sourceType ?? "conversation") as any,
      category: args.category,
      searchAliases: args.searchAliases,
      semanticContext: args.semanticContext,
      entities: args.entities,
      relations: args.relations,
      tags: args.tags ?? [],
      metadata: args.metadata,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(factId);
  },
});

export const listFacts = internalQuery({
  args: {
    memorySpaceId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) => q.eq("memorySpaceId", args.memorySpaceId))
      .order("desc")
      .take(limit);
  },
});

// Alias for http.ts compatibility
export const getFactsBySpace = listFacts;

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const getProject = internalQuery({
  args: { projectId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .first();
    if (!project) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Project not found" });
    }
    return project;
  },
});

export const listProjects = internalQuery({
  args: { accountId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .collect();
  },
});

export const createProject = internalMutation({
  args: {
    projectId: v.string(),
    accountId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    sandbox: v.optional(v.any()),
    isPublic: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      projectId: args.projectId,
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      sandbox: args.sandbox ?? {},
      isPublic: args.isPublic ?? false,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(projectId);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE FOLDER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createKnowledgeBaseFolder = internalMutation({
  args: {
    folderId: v.string(),
    accountId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const folderId = await ctx.db.insert("knowledgeBaseFolders", {
      folderId: args.folderId,
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(folderId);
  },
});

export const getKnowledgeBaseFolder = internalQuery({
  args: { folderId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const folder = await ctx.db
      .query("knowledgeBaseFolders")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .first();
    if (!folder) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base folder not found" });
    }
    return folder;
  },
});

export const listKnowledgeBaseFolders = internalQuery({
  args: { accountId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("knowledgeBaseFolders")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .collect();
  },
});

export const updateKnowledgeBaseFolder = internalMutation({
  args: {
    folderId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const folder = await ctx.db
      .query("knowledgeBaseFolders")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .first();

    if (!folder) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base folder not found" });
    }

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;

    await ctx.db.patch(folder._id, updates);
    return await ctx.db.get(folder._id);
  },
});

export const deleteKnowledgeBaseFolder = internalMutation({
  args: { folderId: v.string() },
  returns: v.object({ success: v.boolean(), folderId: v.string() }),
  handler: async (ctx, args) => {
    const folder = await ctx.db
      .query("knowledgeBaseFolders")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .first();

    if (!folder) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base folder not found" });
    }

    // Soft delete all entries in the folder
    const entries = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
      .collect();

    for (const entry of entries) {
      await ctx.db.patch(entry._id, { isActive: false, updatedAt: Date.now() });
    }

    // Delete the folder
    await ctx.db.delete(folder._id);
    return { success: true, folderId: args.folderId };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE ENTRY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createKnowledgeBaseEntry = internalMutation({
  args: {
    entryId: v.string(),
    accountId: v.string(),
    folderId: v.string(),
    filename: v.string(),
    fileType: v.optional(v.string()),
    fileSize: v.number(),
    storagePath: v.string(),
    summary: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const entryId = await ctx.db.insert("knowledgeBaseEntries", {
      entryId: args.entryId,
      accountId: args.accountId,
      folderId: args.folderId,
      filename: args.filename,
      fileType: args.fileType,
      fileSize: args.fileSize,
      storagePath: args.storagePath,
      summary: args.summary,
      status: args.status ?? "pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(entryId);
  },
});

export const getKnowledgeBaseEntry = internalQuery({
  args: { entryId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_entryId", (q) => q.eq("entryId", args.entryId))
      .first();
    if (!entry) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base entry not found" });
    }
    return entry;
  },
});

export const listKnowledgeBaseEntries = internalQuery({
  args: {
    accountId: v.string(),
    folderId: v.optional(v.string()),
    activeOnly: v.optional(v.boolean()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId));

    const results = await query.order("desc").collect();

    // Filter by folder if specified
    let filtered = results;
    if (args.folderId) {
      filtered = filtered.filter((e) => e.folderId === args.folderId);
    }
    if (args.activeOnly ?? true) {
      filtered = filtered.filter((e) => e.isActive);
    }
    return filtered;
  },
});

export const listKnowledgeBaseEntriesByFolder = internalQuery({
  args: {
    folderId: v.string(),
    activeOnly: v.optional(v.boolean()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    let entries = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
      .order("desc")
      .collect();

    if (args.activeOnly ?? true) {
      entries = entries.filter((e) => e.isActive);
    }
    return entries;
  },
});

export const updateKnowledgeBaseEntry = internalMutation({
  args: {
    entryId: v.string(),
    folderId: v.optional(v.string()),
    filename: v.optional(v.string()),
    summary: v.optional(v.string()),
    status: v.optional(v.string()),
    processingError: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_entryId", (q) => q.eq("entryId", args.entryId))
      .first();

    if (!entry) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base entry not found" });
    }

    const updates: Record<string, any> = { updatedAt: Date.now() };
    if (args.folderId !== undefined) updates.folderId = args.folderId;
    if (args.filename !== undefined) updates.filename = args.filename;
    if (args.summary !== undefined) updates.summary = args.summary;
    if (args.status !== undefined) updates.status = args.status;
    if (args.processingError !== undefined) updates.processingError = args.processingError;
    if (args.isActive !== undefined) updates.isActive = args.isActive;

    await ctx.db.patch(entry._id, updates);
    return await ctx.db.get(entry._id);
  },
});

export const deleteKnowledgeBaseEntry = internalMutation({
  args: { entryId: v.string() },
  returns: v.object({ success: v.boolean(), entryId: v.string() }),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_entryId", (q) => q.eq("entryId", args.entryId))
      .first();

    if (!entry) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Knowledge base entry not found" });
    }

    // Soft delete
    await ctx.db.patch(entry._id, { isActive: false, updatedAt: Date.now() });
    return { success: true, entryId: args.entryId };
  },
});

export const getKnowledgeBaseEntryCountByFolder = internalQuery({
  args: { folderId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
    return entries.length;
  },
});

export const getKnowledgeBaseTotalFileSize = internalQuery({
  args: { accountId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("knowledgeBaseEntries")
      .withIndex("by_account_active", (q) =>
        q.eq("accountId", args.accountId).eq("isActive", true)
      )
      .collect();
    return entries.reduce((sum, e) => sum + e.fileSize, 0);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT KNOWLEDGE ENTRY ASSIGNMENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createAgentKnowledgeEntryAssignment = internalMutation({
  args: {
    assignmentId: v.string(),
    agentId: v.string(),
    entryId: v.string(),
    accountId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    // Check if already exists
    const existing = await ctx.db
      .query("agentKnowledgeEntryAssignments")
      .withIndex("by_agent_entry", (q) =>
        q.eq("agentId", args.agentId).eq("entryId", args.entryId)
      )
      .first();

    if (existing) {
      return existing; // Already assigned
    }

    const now = Date.now();
    const assignmentId = await ctx.db.insert("agentKnowledgeEntryAssignments", {
      assignmentId: args.assignmentId,
      agentId: args.agentId,
      entryId: args.entryId,
      accountId: args.accountId,
      createdAt: now,
    });
    return await ctx.db.get(assignmentId);
  },
});

export const listAgentKnowledgeEntryAssignments = internalQuery({
  args: { agentId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentKnowledgeEntryAssignments")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();
  },
});

export const listAgentIdsByEntry = internalQuery({
  args: { entryId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("agentKnowledgeEntryAssignments")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId))
      .collect();
    return assignments.map((a) => a.agentId);
  },
});

export const deleteAgentKnowledgeEntryAssignment = internalMutation({
  args: {
    agentId: v.string(),
    entryId: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query("agentKnowledgeEntryAssignments")
      .withIndex("by_agent_entry", (q) =>
        q.eq("agentId", args.agentId).eq("entryId", args.entryId)
      )
      .first();

    if (assignment) {
      await ctx.db.delete(assignment._id);
    }
    return { success: true };
  },
});

export const updateAgentKnowledgeEntryAssignments = internalMutation({
  args: {
    agentId: v.string(),
    accountId: v.string(),
    folderIds: v.array(v.string()),
  },
  returns: v.object({ success: v.boolean(), assignedCount: v.number() }),
  handler: async (ctx, args) => {
    // Get all entries from the specified folders
    let allEntries: any[] = [];
    for (const folderId of args.folderIds) {
      const entries = await ctx.db
        .query("knowledgeBaseEntries")
        .withIndex("by_folder", (q) => q.eq("folderId", folderId))
        .filter((q) => q.eq(q.field("isActive"), true))
        .collect();
      allEntries = allEntries.concat(entries);
    }

    // Get current assignments
    const currentAssignments = await ctx.db
      .query("agentKnowledgeEntryAssignments")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();

    const currentEntryIds = new Set(currentAssignments.map((a) => a.entryId));
    const newEntryIds = new Set(allEntries.map((e) => e.entryId));

    // Remove assignments that are no longer needed
    for (const assignment of currentAssignments) {
      if (!newEntryIds.has(assignment.entryId)) {
        await ctx.db.delete(assignment._id);
      }
    }

    // Add new assignments
    let assignedCount = 0;
    const now = Date.now();
    for (const entry of allEntries) {
      if (!currentEntryIds.has(entry.entryId)) {
        await ctx.db.insert("agentKnowledgeEntryAssignments", {
          assignmentId: `assign_${args.agentId}_${entry.entryId}_${now}`,
          agentId: args.agentId,
          entryId: entry.entryId,
          accountId: args.accountId,
          createdAt: now,
        });
        assignedCount++;
      }
    }

    return { success: true, assignedCount: allEntries.length };
  },
});
