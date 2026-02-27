/**
 * Cortex SDK - A2A Communication API
 *
 * Agent-to-agent communication helpers with optional pub/sub support.
 * Provides convenience wrappers over the memory system with source.type='a2a'.
 *
 * Operations:
 * - send(): Fire-and-forget message (no pub/sub required)
 * - request(): Synchronous request-response (requires pub/sub)
 * - broadcast(): One-to-many communication (pub/sub optimal)
 * - getConversation(): Retrieve conversation history (no pub/sub required)
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Send a message from one agent to another.
 * Stores in ACID conversation + both agents' Vector memories.
 *
 * No pub/sub required - this is fire-and-forget.
 */
export const send = mutation({
  args: {
    from: v.string(),
    to: v.string(),
    message: v.string(),
    userId: v.optional(v.string()),
    contextId: v.optional(v.string()),
    importance: v.optional(v.number()),
    trackConversation: v.optional(v.boolean()),
    autoEmbed: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Validation
    if (!args.from || args.from.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'from' agent ID is required");
    }
    if (!args.to || args.to.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'to' agent ID is required");
    }
    if (!args.message || args.message.trim() === "") {
      throw new Error("EMPTY_MESSAGE: Message cannot be empty");
    }
    // Check UTF-8 byte size (not character length) to match Python SDK validation
    const messageByteSize = new TextEncoder().encode(args.message).length;
    if (messageByteSize > 102400) {
      throw new Error(
        `MESSAGE_TOO_LARGE: Message exceeds 100KB limit (current size: ${Math.floor(messageByteSize / 1024)}KB)`,
      );
    }
    if (args.from === args.to) {
      throw new Error("SAME_AGENT_COMMUNICATION: Cannot send message to self");
    }
    const importance = args.importance ?? 60;
    if (importance < 0 || importance > 100) {
      throw new Error(
        "INVALID_IMPORTANCE: Importance must be between 0 and 100",
      );
    }

    const now = Date.now();
    const messageId = `a2a-msg-${now}-${Math.random().toString(36).substring(2, 11)}`;
    const trackConversation = args.trackConversation !== false; // Default true

    let conversationId: string | undefined;
    let acidMessageId: string | undefined;

    // Track in ACID conversation if enabled
    if (trackConversation) {
      // Get or create A2A conversation between these agents
      const sortedAgents = [args.from, args.to].sort();
      const convId = `a2a-conv-${sortedAgents[0]}-${sortedAgents[1]}`;

      let conversation = await ctx.db
        .query("conversations")
        .withIndex("by_conversationId", (q) => q.eq("conversationId", convId))
        .first();

      if (!conversation) {
        // Create new A2A conversation
        const convDocId = await ctx.db.insert("conversations", {
          conversationId: convId,
          memorySpaceId: args.from, // Use sender as primary memory space
          type: "agent-agent",
          participants: {
            memorySpaceIds: [args.from, args.to],
          },
          messages: [],
          messageCount: 0,
          metadata: {
            a2a: true,
            agents: [args.from, args.to],
          },
          createdAt: now,
          updatedAt: now,
        });
        conversation = await ctx.db.get(convDocId);
      }

      if (conversation) {
        // Add message to conversation
        acidMessageId = `a2a-acid-${now}-${Math.random().toString(36).substring(2, 11)}`;
        const message = {
          id: acidMessageId,
          role: "agent" as const,
          content: args.message,
          participantId: args.from,
          metadata: {
            fromAgent: args.from,
            toAgent: args.to,
            messageId,
            timestamp: now,
            ...args.metadata,
          },
          timestamp: now,
        };

        await ctx.db.patch(conversation._id, {
          messages: [...conversation.messages, message],
          messageCount: conversation.messageCount + 1,
          updatedAt: now,
        });

        conversationId = convId;
      }
    }

    // Build tags for sender (outbound)
    const senderTags = [
      "a2a",
      "sent",
      args.to, // Recipient ID for quick filtering
      ...(args.metadata?.tags || []),
    ];

    // Store in sender's vector memory (outbound)
    const senderMemoryId = `mem-a2a-${now}-${Math.random().toString(36).substring(2, 11)}`;
    await ctx.db.insert("memories", {
      memoryId: senderMemoryId,
      memorySpaceId: args.from,
      content: `Sent to ${args.to}: ${args.message}`,
      contentType: "raw",
      sourceType: "a2a",
      sourceTimestamp: now,
      userId: args.userId,
      conversationRef: conversationId
        ? {
            conversationId,
            messageIds: acidMessageId ? [acidMessageId] : [],
          }
        : undefined,
      importance,
      tags: senderTags,
      // A2A-specific metadata (follows documented structure)
      metadata: {
        direction: "outbound",
        fromAgent: args.from,
        toAgent: args.to,
        messageId,
        contextId: args.contextId,
        ...(args.metadata || {}),
      },
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });

    // Build tags for receiver (inbound)
    const receiverTags = [
      "a2a",
      "received",
      args.from, // Sender ID for quick filtering
      ...(args.metadata?.tags || []),
    ];

    // Store in receiver's vector memory (inbound)
    const receiverMemoryId = `mem-a2a-${now + 1}-${Math.random().toString(36).substring(2, 11)}`;
    await ctx.db.insert("memories", {
      memoryId: receiverMemoryId,
      memorySpaceId: args.to,
      content: `Received from ${args.from}: ${args.message}`,
      contentType: "raw",
      sourceType: "a2a",
      sourceTimestamp: now,
      userId: args.userId,
      conversationRef: conversationId
        ? {
            conversationId,
            messageIds: acidMessageId ? [acidMessageId] : [],
          }
        : undefined,
      importance,
      tags: receiverTags,
      // A2A-specific metadata (follows documented structure)
      metadata: {
        direction: "inbound",
        fromAgent: args.from,
        toAgent: args.to,
        messageId,
        contextId: args.contextId,
        ...(args.metadata || {}),
      },
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });

    return {
      messageId,
      sentAt: now,
      conversationId,
      acidMessageId,
      senderMemoryId,
      receiverMemoryId,
    };
  },
});

/**
 * Send a request and wait for response (synchronous request-response).
 *
 * REQUIRES PUB/SUB INFRASTRUCTURE:
 * - Direct Mode: Configure your own Redis/RabbitMQ/NATS adapter
 * - Cloud Mode: Pub/sub infrastructure included automatically
 *
 * This mutation stores the request and returns immediately with a timeout error
 * since pub/sub infrastructure is required for real-time responses.
 */
export const request = mutation({
  args: {
    from: v.string(),
    to: v.string(),
    message: v.string(),
    timeout: v.optional(v.number()),
    retries: v.optional(v.number()),
    userId: v.optional(v.string()),
    contextId: v.optional(v.string()),
    importance: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Validation
    if (!args.from || args.from.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'from' agent ID is required");
    }
    if (!args.to || args.to.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'to' agent ID is required");
    }
    if (!args.message || args.message.trim() === "") {
      throw new Error("EMPTY_MESSAGE: Message cannot be empty");
    }
    // Check UTF-8 byte size (not character length) to match Python SDK validation
    const messageByteSize = new TextEncoder().encode(args.message).length;
    if (messageByteSize > 102400) {
      throw new Error(
        `MESSAGE_TOO_LARGE: Message exceeds 100KB limit (current size: ${Math.floor(messageByteSize / 1024)}KB)`,
      );
    }
    if (args.from === args.to) {
      throw new Error("SAME_AGENT_COMMUNICATION: Cannot send request to self");
    }

    const timeout = args.timeout ?? 30000;
    if (timeout < 1000 || timeout > 300000) {
      throw new Error(
        "INVALID_TIMEOUT: Timeout must be between 1000ms and 300000ms",
      );
    }

    const importance = args.importance ?? 70;
    if (importance < 0 || importance > 100) {
      throw new Error(
        "INVALID_IMPORTANCE: Importance must be between 0 and 100",
      );
    }

    const now = Date.now();
    const messageId = `a2a-req-${now}-${Math.random().toString(36).substring(2, 11)}`;

    // Build tags for sender (request)
    const senderTags = ["a2a", "request", "sent", "pending", args.to];

    // Store the request in sender's memory
    const senderMemoryId = `mem-a2a-req-${now}-${Math.random().toString(36).substring(2, 11)}`;
    await ctx.db.insert("memories", {
      memoryId: senderMemoryId,
      memorySpaceId: args.from,
      content: `Request to ${args.to}: ${args.message}`,
      contentType: "raw",
      sourceType: "a2a",
      sourceTimestamp: now,
      userId: args.userId,
      importance,
      tags: senderTags,
      // A2A request metadata
      metadata: {
        direction: "outbound",
        fromAgent: args.from,
        toAgent: args.to,
        messageId,
        messageType: "request",
        requiresResponse: true,
        responded: false,
        contextId: args.contextId,
        timeout,
      },
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });

    // Build tags for receiver (request received)
    const receiverTags = ["a2a", "request", "received", "pending", args.from];

    // Store in receiver's memory
    const receiverMemoryId = `mem-a2a-req-${now + 1}-${Math.random().toString(36).substring(2, 11)}`;
    await ctx.db.insert("memories", {
      memoryId: receiverMemoryId,
      memorySpaceId: args.to,
      content: `Request from ${args.from}: ${args.message}`,
      contentType: "raw",
      sourceType: "a2a",
      sourceTimestamp: now,
      userId: args.userId,
      importance,
      tags: receiverTags,
      // A2A request metadata
      metadata: {
        direction: "inbound",
        fromAgent: args.from,
        toAgent: args.to,
        messageId,
        messageType: "request",
        requiresResponse: true,
        responded: false,
        contextId: args.contextId,
      },
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });

    // Return timeout indicator - real-time response requires pub/sub
    throw new ConvexError(
      "PUBSUB_NOT_CONFIGURED: request() requires pub/sub infrastructure for real-time responses. " +
        "In Direct Mode, configure your own Redis/RabbitMQ/NATS adapter. " +
        "In Cloud Mode, pub/sub is included automatically. " +
        `Request stored with messageId: ${messageId}`,
    );
  },
});

/**
 * Broadcast a message to multiple agents.
 *
 * REQUIRES PUB/SUB for optimized delivery confirmation.
 * Without pub/sub, messages are stored but delivery is not confirmed.
 */
export const broadcast = mutation({
  args: {
    from: v.string(),
    to: v.array(v.string()),
    message: v.string(),
    userId: v.optional(v.string()),
    contextId: v.optional(v.string()),
    importance: v.optional(v.number()),
    trackConversation: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Validation
    if (!args.from || args.from.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'from' agent ID is required");
    }
    if (!args.message || args.message.trim() === "") {
      throw new Error("EMPTY_MESSAGE: Message cannot be empty");
    }
    // Check UTF-8 byte size (not character length) to match Python SDK validation
    const messageByteSize = new TextEncoder().encode(args.message).length;
    if (messageByteSize > 102400) {
      throw new Error(
        `MESSAGE_TOO_LARGE: Message exceeds 100KB limit (current size: ${Math.floor(messageByteSize / 1024)}KB)`,
      );
    }
    if (!args.to || args.to.length === 0) {
      throw new Error("EMPTY_RECIPIENTS: Recipients array cannot be empty");
    }
    if (args.to.length > 100) {
      throw new Error("TOO_MANY_RECIPIENTS: Maximum 100 recipients allowed");
    }

    // Check for duplicates
    const uniqueRecipients = new Set(args.to);
    if (uniqueRecipients.size !== args.to.length) {
      throw new Error(
        "DUPLICATE_RECIPIENTS: Recipients array contains duplicates",
      );
    }

    // Check for sender in recipients
    if (args.to.includes(args.from)) {
      throw new Error("INVALID_RECIPIENT: Sender cannot be in recipients list");
    }

    // Validate all recipient IDs
    for (const recipient of args.to) {
      if (!recipient || recipient.trim() === "") {
        throw new Error(
          "INVALID_AGENT_ID: All recipient IDs must be non-empty",
        );
      }
    }

    const importance = args.importance ?? 60;
    if (importance < 0 || importance > 100) {
      throw new Error(
        "INVALID_IMPORTANCE: Importance must be between 0 and 100",
      );
    }

    const now = Date.now();
    const broadcastId = `a2a-broadcast-${now}-${Math.random().toString(36).substring(2, 11)}`;
    const trackConversation = args.trackConversation !== false;

    const senderMemoryIds: string[] = [];
    const receiverMemoryIds: string[] = [];
    const conversationIds: string[] = [];

    // Send to each recipient
    for (let i = 0; i < args.to.length; i++) {
      const recipient = args.to[i];
      const messageId = `${broadcastId}-${i}`;

      let conversationId: string | undefined;
      let acidMessageId: string | undefined;

      // Track in ACID conversation if enabled
      if (trackConversation) {
        const sortedAgents = [args.from, recipient].sort();
        const convId = `a2a-conv-${sortedAgents[0]}-${sortedAgents[1]}`;

        let conversation = await ctx.db
          .query("conversations")
          .withIndex("by_conversationId", (q) => q.eq("conversationId", convId))
          .first();

        if (!conversation) {
          const convDocId = await ctx.db.insert("conversations", {
            conversationId: convId,
            memorySpaceId: args.from,
            type: "agent-agent",
            participants: {
              memorySpaceIds: [args.from, recipient],
            },
            messages: [],
            messageCount: 0,
            metadata: {
              a2a: true,
              agents: [args.from, recipient],
            },
            createdAt: now,
            updatedAt: now,
          });
          conversation = await ctx.db.get(convDocId);
        }

        if (conversation) {
          acidMessageId = `a2a-acid-${now}-${i}-${Math.random().toString(36).substring(2, 7)}`;
          const message = {
            id: acidMessageId,
            role: "agent" as const,
            content: args.message,
            participantId: args.from,
            metadata: {
              fromAgent: args.from,
              toAgent: recipient,
              messageId,
              broadcastId,
              broadcast: true,
              timestamp: now,
              ...args.metadata,
            },
            timestamp: now,
          };

          await ctx.db.patch(conversation._id, {
            messages: [...conversation.messages, message],
            messageCount: conversation.messageCount + 1,
            updatedAt: now,
          });

          conversationId = convId;
          conversationIds.push(convId);
        }
      }

      // Build tags for sender (broadcast)
      const senderTags = [
        "a2a",
        "broadcast",
        "sent",
        recipient,
        ...(args.metadata?.tags || []),
      ];

      // Store in sender's memory
      const senderMemoryId = `mem-a2a-bc-${now}-${i}-s-${Math.random().toString(36).substring(2, 7)}`;
      await ctx.db.insert("memories", {
        memoryId: senderMemoryId,
        memorySpaceId: args.from,
        content: `Broadcast to ${recipient}: ${args.message}`,
        contentType: "raw",
        sourceType: "a2a",
        sourceTimestamp: now,
        userId: args.userId,
        conversationRef: conversationId
          ? {
              conversationId,
              messageIds: acidMessageId ? [acidMessageId] : [],
            }
          : undefined,
        importance,
        tags: senderTags,
        // A2A broadcast metadata
        metadata: {
          direction: "outbound",
          fromAgent: args.from,
          toAgent: recipient,
          messageId,
          broadcastId,
          broadcast: true,
          contextId: args.contextId,
          ...(args.metadata || {}),
        },
        version: 1,
        previousVersions: [],
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
      });
      senderMemoryIds.push(senderMemoryId);

      // Build tags for receiver (broadcast received)
      const receiverTags = [
        "a2a",
        "broadcast",
        "received",
        args.from,
        ...(args.metadata?.tags || []),
      ];

      // Store in receiver's memory
      const receiverMemoryId = `mem-a2a-bc-${now}-${i}-r-${Math.random().toString(36).substring(2, 7)}`;
      await ctx.db.insert("memories", {
        memoryId: receiverMemoryId,
        memorySpaceId: recipient,
        content: `Broadcast from ${args.from}: ${args.message}`,
        contentType: "raw",
        sourceType: "a2a",
        sourceTimestamp: now,
        userId: args.userId,
        conversationRef: conversationId
          ? {
              conversationId,
              messageIds: acidMessageId ? [acidMessageId] : [],
            }
          : undefined,
        importance,
        tags: receiverTags,
        // A2A broadcast metadata
        metadata: {
          direction: "inbound",
          fromAgent: args.from,
          toAgent: recipient,
          messageId,
          broadcastId,
          broadcast: true,
          contextId: args.contextId,
          ...(args.metadata || {}),
        },
        version: 1,
        previousVersions: [],
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
      });
      receiverMemoryIds.push(receiverMemoryId);
    }

    return {
      messageId: broadcastId,
      sentAt: now,
      recipients: args.to,
      senderMemoryIds,
      receiverMemoryIds,
      memoriesCreated: senderMemoryIds.length + receiverMemoryIds.length,
      conversationIds: trackConversation ? conversationIds : undefined,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get conversation between two agents with filtering.
 *
 * No pub/sub required - this is a database query only.
 */
export const getConversation = query({
  args: {
    agent1: v.string(),
    agent2: v.string(),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    minImportance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    userId: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Validation
    if (!args.agent1 || args.agent1.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'agent1' is required");
    }
    if (!args.agent2 || args.agent2.trim() === "") {
      throw new Error("INVALID_AGENT_ID: 'agent2' is required");
    }

    const limit = args.limit ?? 100;
    if (limit <= 0 || limit > 1000) {
      throw new Error("INVALID_LIMIT: Limit must be between 1 and 1000");
    }

    const offset = args.offset ?? 0;
    if (offset < 0) {
      throw new Error("INVALID_OFFSET: Offset cannot be negative");
    }

    if (args.since && args.until && args.since > args.until) {
      throw new Error("INVALID_DATE_RANGE: 'since' must be before 'until'");
    }

    if (
      args.minImportance !== undefined &&
      (args.minImportance < 0 || args.minImportance > 100)
    ) {
      throw new Error(
        "INVALID_IMPORTANCE: minImportance must be between 0 and 100",
      );
    }

    // Get A2A conversation ID
    const sortedAgents = [args.agent1, args.agent2].sort();
    const conversationId = `a2a-conv-${sortedAgents[0]}-${sortedAgents[1]}`;

    // Try to get ACID conversation
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .first();

    // Get A2A memories from agent1's perspective (includes both sent and received)
    let agent1Memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) => q.eq("memorySpaceId", args.agent1))
      .collect();

    // Filter for A2A messages with agent2 using metadata
    agent1Memories = agent1Memories.filter((m) => {
      if (m.sourceType !== "a2a") return false;

      // Use metadata to check if this memory involves agent2
      const meta = m.metadata as
        | { fromAgent?: string; toAgent?: string }
        | undefined;
      if (!meta) return false;

      return (
        (meta.fromAgent === args.agent1 && meta.toAgent === args.agent2) ||
        (meta.fromAgent === args.agent2 && meta.toAgent === args.agent1)
      );
    });

    // Apply filters
    if (args.since) {
      agent1Memories = agent1Memories.filter((m) => m.createdAt >= args.since!);
    }
    if (args.until) {
      agent1Memories = agent1Memories.filter((m) => m.createdAt <= args.until!);
    }
    if (args.minImportance !== undefined) {
      agent1Memories = agent1Memories.filter(
        (m) => m.importance >= args.minImportance!,
      );
    }
    if (args.tags && args.tags.length > 0) {
      agent1Memories = agent1Memories.filter((m) =>
        args.tags!.some((tag) => m.tags.includes(tag)),
      );
    }
    if (args.userId) {
      agent1Memories = agent1Memories.filter((m) => m.userId === args.userId);
    }

    // Sort chronologically
    agent1Memories.sort((a, b) => a.createdAt - b.createdAt);

    // Apply pagination
    const paginatedMemories = agent1Memories.slice(offset, offset + limit);

    // Transform to conversation messages
    const messages = paginatedMemories.map((m) => {
      const meta = m.metadata as
        | {
            fromAgent?: string;
            toAgent?: string;
            messageId?: string;
            direction?: string;
            broadcast?: boolean;
            broadcastId?: string;
          }
        | undefined;

      // Filter out internal tags for user-facing output
      const userTags = m.tags.filter(
        (t) =>
          ![
            "a2a",
            "sent",
            "received",
            "broadcast",
            "request",
            "pending",
          ].includes(t) &&
          t !== args.agent1 &&
          t !== args.agent2,
      );

      return {
        from: meta?.fromAgent || args.agent1,
        to: meta?.toAgent || args.agent2,
        message: m.content.replace(
          /^(Sent to [^:]+: |Received from [^:]+: |Broadcast to [^:]+: |Broadcast from [^:]+: |Request to [^:]+: |Request from [^:]+: )/,
          "",
        ),
        importance: m.importance,
        timestamp: m.createdAt,
        messageId: meta?.messageId || m.memoryId,
        memoryId: m.memoryId,
        acidMessageId: m.conversationRef?.messageIds?.[0],
        tags: userTags,
        direction: meta?.direction,
        broadcast: meta?.broadcast,
        broadcastId: meta?.broadcastId,
      };
    });

    // Calculate period
    const timestamps = messages.map((m) => m.timestamp);
    const period =
      timestamps.length > 0
        ? {
            start: Math.min(...timestamps),
            end: Math.max(...timestamps),
          }
        : {
            start: Date.now(),
            end: Date.now(),
          };

    // Collect unique user tags
    const allTags = new Set<string>();
    messages.forEach((m) => m.tags.forEach((t) => allTags.add(t)));

    return {
      participants: [args.agent1, args.agent2] as [string, string],
      conversationId: conversation ? conversationId : undefined,
      messageCount: agent1Memories.length,
      messages,
      period,
      tags: allTags.size > 0 ? Array.from(allTags) : undefined,
      canRetrieveFullHistory: !!conversation,
    };
  },
});
