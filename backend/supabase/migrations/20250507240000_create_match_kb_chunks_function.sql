-- File: backend/supabase/migrations/YYYYMMDDHHMMSS_create_match_kb_chunks_function.sql
-- Replace YYYYMMDDHHMMSS with the actual timestamp of when this migration is created.

-- Function to find relevant knowledge base chunks based on vector similarity (Optimized for HNSW)
CREATE OR REPLACE FUNCTION public.match_kb_chunks (
  p_project_id UUID,
  query_embedding vector(1024), -- Dimension for embeddings (e.g., 1024 for intfloat/multilingual-e5-large, 1536 for ada-002). Adjust if using a different model.
  match_count int,
  match_threshold float,
  p_ef_search int DEFAULT 60 -- HNSW ef_search parameter, default 60, can be tuned
)
RETURNS TABLE (
  id UUID,
  document_id UUID,
  chunk_text TEXT,
  metadata JSONB,
  similarity REAL
)
AS $$
DECLARE
  original_ef_search text;
BEGIN
  -- Set hnsw.ef_search for this transaction. Store original value to reset.
  -- Note: SHOW and SET commands might require superuser privileges in some environments or specific pgvector versions for SECURITY DEFINER functions.
  -- If issues arise, consider setting ef_search outside the function if possible, or ensure appropriate grants.
  original_ef_search := current_setting('hnsw.ef_search', true);
  EXECUTE 'SET LOCAL hnsw.ef_search = ' || p_ef_search::text;

  RETURN QUERY
  WITH chunks_ranked_by_similarity AS (
    -- Step 1: Perform vector search using HNSW index, get more candidates than match_count
    -- Order by distance (<=>) which is efficient with HNSW.
    SELECT
      kbc.id,
      kbc.document_id,
      kbc.chunk_text,
      kbc.metadata,
      (1 - (POWER(kbc.embedding <=> query_embedding, 2) / 2.0))::real AS similarity -- Calculate cosine similarity from L2 distance
    FROM
      public.knowledge_base_chunks kbc
    -- No pre-filtering on kbc here unless project_id is directly on it and indexed.
    ORDER BY
      kbc.embedding <=> query_embedding
    LIMIT LEAST(match_count * 5, 500) -- Fetch more results to filter later, e.g., 5x match_count, capped at 500 (tune as needed)
  )
  -- Step 2: Join with documents table, apply project and status filters, and the similarity threshold
  SELECT
    crs.id,
    crs.document_id,
    crs.chunk_text,
    crs.metadata,
    crs.similarity
  FROM
    chunks_ranked_by_similarity crs
  JOIN
    public.knowledge_base_documents kbd ON crs.document_id = kbd.id
  WHERE
    kbd.project_id = p_project_id 
    AND kbd.status = 'indexed'
    AND crs.similarity >= match_threshold -- Apply similarity threshold (use >= as it's similarity now)
  ORDER BY
    crs.similarity DESC
  LIMIT match_count;

  -- Reset hnsw.ef_search to its original value
  EXECUTE 'SET LOCAL hnsw.ef_search = ' || quote_ident(original_ef_search);

EXCEPTION
  WHEN OTHERS THEN
    -- In case of any error, try to reset ef_search before re-raising
    BEGIN
      EXECUTE 'SET LOCAL hnsw.ef_search = ' || quote_ident(original_ef_search);
    EXCEPTION
      WHEN OTHERS THEN -- If resetting also fails, log or ignore
        RAISE WARNING 'Failed to reset hnsw.ef_search in exception handler: %', SQLERRM;
    END;
    RAISE; -- Re-raise the original exception
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission to the authenticated role (or service_role if preferred)
-- Depending on how your backend calls RPC functions (user context vs service role context)
GRANT EXECUTE
  ON FUNCTION public.match_kb_chunks(UUID, vector, int, float, int) -- Added p_ef_search parameter
  TO authenticated;

-- If your backend calls RPC using the service role key, grant to service_role instead or in addition:
GRANT EXECUTE
  ON FUNCTION public.match_kb_chunks(UUID, vector, int, float, int) -- Added p_ef_search parameter
  TO service_role; 