import { useQuery, useMutation } from "convex/react";
import { api } from "./api";

// ═══════════════════════════════════════════════════════════════════════════════
// Conversation Hooks (Layer 1a - ACID, Immutable)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a single conversation by ID
 */
export function useConversation(conversationId: string | undefined) {
  return useQuery(
    api.conversations.get,
    conversationId ? { conversationId } : "skip"
  );
}

/**
 * List conversations with filters
 */
export function useConversations(
  memorySpaceId: string | undefined,
  userId?: string,
  limit = 100
) {
  return useQuery(
    api.conversations.list,
    memorySpaceId
      ? { memorySpaceId, userId, limit }
      : "skip"
  );
}

/**
 * Get conversation history (paginated messages)
 */
export function useConversationHistory(
  conversationId: string | undefined,
  limit = 50,
  offset = 0
) {
  return useQuery(
    api.conversations.getHistory,
    conversationId ? { conversationId, limit, offset } : "skip"
  );
}

/**
 * Create a new conversation
 */
export function useCreateConversation() {
  return useMutation(api.conversations.create);
}

/**
 * Get or create a conversation
 */
export function useGetOrCreateConversation() {
  return useMutation(api.conversations.getOrCreate);
}

/**
 * Add a message to a conversation
 */
export function useAddMessage() {
  return useMutation(api.conversations.addMessage);
}

/**
 * Delete a conversation
 */
export function useDeleteConversation() {
  return useMutation(api.conversations.deleteConversation);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent Hooks (SDK Agent Registry)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get an agent by ID
 */
export function useAgent(agentId: string | undefined) {
  return useQuery(
    api.agents.get,
    agentId ? { agentId } : "skip"
  );
}

/**
 * List agents with optional status filter
 */
export function useAgents(
  status?: "active" | "inactive" | "archived",
  limit = 100
) {
  return useQuery(
    api.agents.list,
    status ? { status, limit } : { limit }
  );
}

/**
 * Register a new agent
 */
export function useRegisterAgent() {
  return useMutation(api.agents.register);
}

/**
 * Update an agent
 */
export function useUpdateAgent() {
  return useMutation(api.agents.update);
}

/**
 * Unregister an agent
 */
export function useUnregisterAgent() {
  return useMutation(api.agents.unregister);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory Hooks (Layer 2 - Vector Memory)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get memories for a memory space
 */
export function useMemories(
  memorySpaceId: string | undefined,
  userId?: string,
  limit = 100
) {
  return useQuery(
    api.memories.list,
    memorySpaceId ? { memorySpaceId, userId, limit } : "skip"
  );
}

/**
 * Search memories by content or embedding
 */
export function useSearchMemories(
  memorySpaceId: string | undefined,
  query: string,
  embedding?: number[],
  limit = 20
) {
  return useQuery(
    api.memories.search,
    memorySpaceId && query
      ? { memorySpaceId, query, embedding, limit }
      : "skip"
  );
}

/**
 * Store a new memory
 */
export function useStoreMemory() {
  return useMutation(api.memories.store);
}

/**
 * Delete a memory
 */
export function useDeleteMemory() {
  return useMutation(api.memories.deleteMemory);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fact Hooks (Layer 3 - Facts Store)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get facts for a memory space
 */
export function useFacts(
  memorySpaceId: string | undefined,
  factType?: string,
  limit = 100
) {
  return useQuery(
    api.facts.list,
    memorySpaceId
      ? { memorySpaceId, factType: factType as any, limit }
      : "skip"
  );
}

/**
 * Search facts by content
 */
export function useSearchFacts(
  memorySpaceId: string | undefined,
  query: string,
  limit = 20
) {
  return useQuery(
    api.facts.search,
    memorySpaceId && query ? { memorySpaceId, query, limit } : "skip"
  );
}

/**
 * Store a new fact
 */
export function useStoreFact() {
  return useMutation(api.facts.store);
}

/**
 * Update a fact
 */
export function useUpdateFact() {
  return useMutation(api.facts.update);
}

/**
 * Delete a fact
 */
export function useDeleteFact() {
  return useMutation(api.facts.deleteFact);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mutable Store Hooks (Layer 1c - ACID, No Versioning)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a value from mutable store
 */
export function useMutableGet(namespace: string, key: string | undefined) {
  return useQuery(
    api.mutable.get,
    key ? { namespace, key } : "skip"
  );
}

/**
 * List values in a namespace
 */
export function useMutableList(
  namespace: string,
  keyPrefix?: string,
  limit = 100
) {
  return useQuery(
    api.mutable.list,
    { namespace, keyPrefix, limit }
  );
}

/**
 * Set a value in mutable store
 */
export function useMutableSet() {
  return useMutation(api.mutable.set);
}

/**
 * Update a value in mutable store
 */
export function useMutableUpdate() {
  return useMutation(api.mutable.update);
}

/**
 * Delete a key from mutable store
 */
export function useMutableDelete() {
  return useMutation(api.mutable.deleteKey);
}
