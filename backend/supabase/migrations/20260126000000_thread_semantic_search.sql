-- ============================================================================
-- THREAD SEMANTIC SEARCH - Vector Embeddings with Supabase pgvector
-- ============================================================================
--
-- WHAT THIS DOES
-- --------------
-- This migration enables semantic search for threads. Instead of basic keyword
-- matching ("find threads containing 'invoice'"), users can search by meaning
-- ("find threads about billing issues") - even if the word "billing" never appears.
--
-- HOW IT WORKS
-- ------------
-- 1. When a thread accumulates conversation history, we chunk the content into
--    ~1200 character pieces (with 100 char overlap to preserve context at boundaries)
--
-- 2. Each chunk gets converted to a 1536-dimensional vector using OpenAI's
--    text-embedding-3-small model. Think of this vector as a "fingerprint" that
--    captures the semantic meaning of the text.
--
-- 3. When a user searches, their query also becomes a vector. We then find chunks
--    whose vectors are "close" to the query vector using cosine similarity.
--    Closer vectors = more semantically similar content.
--
-- WHY SUPABASE PGVECTOR (not Qdrant/Pinecone/etc)
-- -----------------------------------------------
-- - Zero additional infrastructure: pgvector runs inside your existing Postgres
-- - No extra API keys or services to manage
-- - Transactional consistency: embeddings and thread data stay in sync
-- - Cost effective: no per-query pricing from external vector DBs
-- - Good enough performance for most use cases (pgvector has come a long way)
--
-- THE DOCUMENTS TABLE STRUCTURE
-- -----------------------------
-- We're adapting the existing `documents` table (which had id, content, embedding):
--
--   chunk_id      - Primary key (UUID). Each chunk gets a unique ID.
--   thread_id     - Which thread this chunk belongs to. NOT unique - one thread
--                   can have many chunks (long conversations get split up).
--   user_id       - Who owns this thread. Useful for filtering searches.
--   chunk_content - The actual text (up to 1200 chars).
--   embedding     - The 1536-dim vector from OpenAI.
--   last_updated_at - When we last refreshed this embedding.
--
-- WHY CHUNKING?
-- -------------
-- Embedding models have token limits, and smaller chunks often give better
-- search precision. If you embed a 50,000 character conversation as one blob,
-- the vector becomes a "blurry average" of everything discussed. Chunking lets
-- us pinpoint exactly which part of the conversation matches the query.
--
-- The 100-char overlap ensures we don't accidentally split a sentence in half
-- and lose meaning at chunk boundaries.
--
-- POTENTIAL PITFALLS
-- ------------------
-- 1. OpenAI API costs: Each embedding call costs money. The backfill script
--    has a small delay (50ms) between chunks to avoid rate limits.
--
-- 2. Stale embeddings: If users edit messages (rare in chat), embeddings won't
--    auto-update. The search_embedded_at column helps track freshness.
--
-- 3. Cold start: New threads won't be searchable until embedded. The background
--    job handles this, but there's a delay (currently checks hourly for threads
--    older than 24h without embeddings).
--
-- ============================================================================

-- Enable pgvector extension (idempotent - safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- DOCUMENTS TABLE (CREATE FROM SCRATCH)
-- ----------------------------------------------------------------------------

-- Create the documents table for storing thread chunks with embeddings
CREATE TABLE IF NOT EXISTS documents (
    chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID,
    user_id UUID,
    chunk_content TEXT,
    embedding vector(1536),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index on thread_id for fast lookups ("get all chunks for thread X")
-- Not unique because one thread can have many chunks
CREATE INDEX IF NOT EXISTS idx_documents_thread_id
ON documents(thread_id);

-- Partial index on user_id (only indexes non-null values, saves space)
CREATE INDEX IF NOT EXISTS idx_documents_user_id
ON documents(user_id)
WHERE user_id IS NOT NULL;

-- Vector index for fast cosine similarity search using HNSW algorithm
-- vector_cosine_ops tells pgvector to use cosine distance (<=> operator)
-- HNSW is better than IVFFlat for datasets under 1M vectors
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING hnsw (embedding vector_cosine_ops);

-- Column documentation (shows up in Supabase dashboard)
COMMENT ON COLUMN documents.chunk_id IS 'Unique identifier for this chunk';
COMMENT ON COLUMN documents.thread_id IS 'The thread this chunk belongs to';
COMMENT ON COLUMN documents.chunk_content IS 'The text content of this chunk (max ~1200 chars)';
COMMENT ON COLUMN documents.user_id IS 'The user who owns this thread';
COMMENT ON COLUMN documents.last_updated_at IS 'When this embedding was last updated';

-- ----------------------------------------------------------------------------
-- NOTE: No changes needed to threads table
-- ----------------------------------------------------------------------------
-- We can check if a thread is embedded by querying:
--   SELECT EXISTS (SELECT 1 FROM documents WHERE thread_id = ?)
--
-- Or find threads needing embedding with:
--   SELECT t.thread_id FROM threads t
--   WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.thread_id = t.thread_id)
--
-- This avoids redundant data (search_embedded_at) that needs to stay in sync.

-- ============================================================================
-- USAGE NOTES
-- ============================================================================
--
-- After running this migration:
--
-- 1. Run the backfill script to embed existing threads:
--    cd backend && uv run python scripts/backfill_thread_embeddings.py
--
-- 2. The search endpoint is: GET /v1/threads/search?q=your+query&limit=10
--
-- 3. Frontend uses the useThreadSearch hook with 400ms debouncing
--
-- 4. To enable automatic embedding of new threads, uncomment the scheduler
--    in backend/api.py (currently disabled until migration is applied)
--
-- ============================================================================
