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
-
-- Enable pgvector extension (idempotent - safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- PREREQUISITE: Ensure threads has a unique constraint on (account_id, thread_id)
-- so the foreign key below can reference it.
-- thread_id is already the PK, but Postgres FK needs an exact match on the
-- referenced columns, so we add a UNIQUE constraint on the pair.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'threads_account_id_thread_id_key'
    ) THEN
        ALTER TABLE threads
            ADD CONSTRAINT threads_account_id_thread_id_key
            UNIQUE (account_id, thread_id);
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- DOCUMENTS TABLE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
    chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,
    thread_id UUID NOT NULL,

    chunk_content TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT documents_thread_account_fkey
        FOREIGN KEY (account_id, thread_id)
        REFERENCES threads(account_id, thread_id)
        ON DELETE CASCADE
);

-- Composite index on (account_id, thread_id) for fast scoped lookups
-- "get all chunks for this account's thread" is the most common query pattern
CREATE INDEX IF NOT EXISTS idx_documents_account_thread
ON documents(account_id, thread_id);

-- Index on account_id alone for search queries that scan all of a user's chunks
CREATE INDEX IF NOT EXISTS idx_documents_account_id
ON documents(account_id);

-- Vector index for fast cosine similarity search using HNSW algorithm
-- vector_cosine_ops tells pgvector to use cosine distance (<=> operator)
-- HNSW is better than IVFFlat for datasets under 1M vectors
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING hnsw (embedding vector_cosine_ops);

-- Column documentation (shows up in Supabase dashboard)
COMMENT ON COLUMN documents.chunk_id IS 'Unique identifier for this chunk';
COMMENT ON COLUMN documents.account_id IS 'The account that owns this thread (tenant scoping)';
COMMENT ON COLUMN documents.thread_id IS 'The thread this chunk belongs to';
COMMENT ON COLUMN documents.chunk_content IS 'The text content of this chunk (max ~1200 chars)';
COMMENT ON COLUMN documents.embedding IS 'The 1536-dim vector from OpenAI text-embedding-3-small';
COMMENT ON COLUMN documents.last_updated_at IS 'When this embedding was last created/refreshed';
