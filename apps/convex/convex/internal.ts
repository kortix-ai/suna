/**
 * Kortix Suna - Internal Functions for Python Backend Integration
 *
 * These functions are called by HTTP actions to perform database operations.
 */

import { internalMutation, internalQuery, ConvexError } from "./_generated/server";
import { v } from "convex/values";

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
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("threads")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId));

    if (args.projectId) {
      query = ctx.db
        .query("threads")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId));
    }

    const limit = args.limit ?? 100;
    return await query.order("desc").take(limit);
  },
});

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

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT RUN OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const createAgentRun = internalMutation({
  args: {
    runId: v.string(),
    threadId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", {
      runId: args.runId,
      threadId: args.threadId,
      status: "queued",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
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

    await ctx.db.patch(run._id, updates);
    return await ctx.db.get(run._id);
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

export const createAgent = internalMutation({
  args: {
    agentId: v.string(),
    accountId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.string(),
    configuredMcps: v.optional(v.any()),
    agentpressTools: v.optional(v.any()),
    isDefault: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
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
      agentpressTools: args.agentpressTools ?? {},
      isDefault: args.isDefault ?? false,
      metadata: args.metadata,
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
    agentpressTools: v.optional(v.any()),
    metadata: v.optional(v.any()),
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
    if (args.agentpressTools !== undefined) updates.agentpressTools = args.agentpressTools;
    if (args.metadata !== undefined) updates.metadata = args.metadata;

    await ctx.db.patch(agent._id, updates);
    return await ctx.db.get(agent._id);
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

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY OPERATIONS (Cortex SDK)
// ═══════════════════════════════════════════════════════════════════════════════

export const storeMemory = internalMutation({
  args: {
    memoryId: v.string(),
    memorySpaceId: v.string(),
    content: v.string(),
    contentType: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    sourceType: v.string(),
    sourceUserId: v.optional(v.string()),
    sourceUserName: v.optional(v.string()),
    messageRole: v.optional(v.string()),
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
      content: args.content,
      contentType: args.contentType ?? "raw",
      embedding: args.embedding,
      sourceType: args.sourceType as any,
      sourceUserId: args.sourceUserId,
      sourceUserName: args.sourceUserName,
      messageRole: args.messageRole as any,
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

// ═══════════════════════════════════════════════════════════════════════════════
// FACT OPERATIONS (Cortex SDK)
// ═══════════════════════════════════════════════════════════════════════════════

export const storeFact = internalMutation({
  args: {
    factId: v.string(),
    memorySpaceId: v.string(),
    fact: v.string(),
    factType: v.string(),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    confidence: v.optional(v.number()),
    sourceType: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const factId = await ctx.db.insert("facts", {
      factId: args.factId,
      memorySpaceId: args.memorySpaceId,
      fact: args.fact,
      factType: args.factType as any,
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      confidence: args.confidence ?? 80,
      sourceType: (args.sourceType ?? "conversation") as any,
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
