CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE memory_type AS ENUM ('fact', 'preference', 'context', 'conversation_summary');
CREATE TYPE memory_extraction_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE user_memories (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    content TEXT NOT NULL,
    memory_type memory_type NOT NULL DEFAULT 'fact',
    embedding vector(1536),
    source_thread_id UUID,
    confidence_score FLOAT DEFAULT 0.8,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT fk_account FOREIGN KEY (account_id) 
        REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_source_thread FOREIGN KEY (source_thread_id) 
        REFERENCES threads(thread_id) ON DELETE SET NULL
);

CREATE TABLE memory_extraction_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    thread_id UUID NOT NULL,
    message_ids JSONB NOT NULL DEFAULT '[]',
    status memory_extraction_status NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 5,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    
    CONSTRAINT fk_account FOREIGN KEY (account_id) 
        REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_thread FOREIGN KEY (thread_id) 
        REFERENCES threads(thread_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_memories_account_id ON user_memories(account_id);
CREATE INDEX idx_user_memories_memory_type ON user_memories(memory_type);
CREATE INDEX idx_user_memories_created_at ON user_memories(created_at DESC);
CREATE INDEX idx_user_memories_source_thread ON user_memories(source_thread_id) WHERE source_thread_id IS NOT NULL;

CREATE INDEX idx_user_memories_embedding_vector ON user_memories 
    USING ivfflat (embedding vector_cosine_ops) 
    WITH (lists = 100);

CREATE INDEX idx_memory_queue_status ON memory_extraction_queue(status) WHERE status IN ('pending', 'processing');
CREATE INDEX idx_memory_queue_account_id ON memory_extraction_queue(account_id);
CREATE INDEX idx_memory_queue_priority ON memory_extraction_queue(priority DESC, created_at ASC);
CREATE INDEX idx_memory_queue_thread_id ON memory_extraction_queue(thread_id);

CREATE OR REPLACE FUNCTION update_user_memories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_user_memories_updated_at
    BEFORE UPDATE ON user_memories
    FOR EACH ROW
    EXECUTE FUNCTION update_user_memories_updated_at();

CREATE OR REPLACE FUNCTION search_memories_by_similarity(
    p_account_id UUID,
    p_query_embedding vector(1536),
    p_limit INTEGER DEFAULT 10,
    p_similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    memory_id UUID,
    content TEXT,
    memory_type memory_type,
    confidence_score FLOAT,
    similarity FLOAT,
    metadata JSONB,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        um.memory_id,
        um.content,
        um.memory_type,
        um.confidence_score,
        1 - (um.embedding <=> p_query_embedding) AS similarity,
        um.metadata,
        um.created_at
    FROM user_memories um
    WHERE um.account_id = p_account_id
        AND um.embedding IS NOT NULL
        AND (1 - (um.embedding <=> p_query_embedding)) >= p_similarity_threshold
    ORDER BY um.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_memory_stats(p_account_id UUID)
RETURNS TABLE (
    total_memories BIGINT,
    memories_by_type JSONB,
    oldest_memory TIMESTAMPTZ,
    newest_memory TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT,
        jsonb_object_agg(memory_type, count) AS memories_by_type,
        MIN(created_at),
        MAX(created_at)
    FROM (
        SELECT 
            um.memory_type,
            COUNT(*) as count,
            um.created_at
        FROM user_memories um
        WHERE um.account_id = p_account_id
        GROUP BY um.memory_type, um.created_at
    ) subquery;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_extraction_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own memories"
    ON user_memories FOR SELECT
    TO authenticated
    USING (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid() 
            OR id IN (SELECT account_id FROM basejump.account_user WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "Users can insert their own memories"
    ON user_memories FOR INSERT
    TO authenticated
    WITH CHECK (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid() 
            OR id IN (SELECT account_id FROM basejump.account_user WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "Users can update their own memories"
    ON user_memories FOR UPDATE
    TO authenticated
    USING (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid() 
            OR id IN (SELECT account_id FROM basejump.account_user WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "Users can delete their own memories"
    ON user_memories FOR DELETE
    TO authenticated
    USING (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid() 
            OR id IN (SELECT account_id FROM basejump.account_user WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "Service role has full access to memories"
    ON user_memories FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Users can view their own extraction queue"
    ON memory_extraction_queue FOR SELECT
    TO authenticated
    USING (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid() 
            OR id IN (SELECT account_id FROM basejump.account_user WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "Service role has full access to extraction queue"
    ON memory_extraction_queue FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_memories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_extraction_queue TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_memories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_extraction_queue TO service_role;
GRANT EXECUTE ON FUNCTION search_memories_by_similarity TO authenticated;
GRANT EXECUTE ON FUNCTION get_memory_stats TO authenticated;

COMMENT ON TABLE user_memories IS 'Stores user context and memories extracted from conversations for personalized AI interactions';
COMMENT ON TABLE memory_extraction_queue IS 'Background job queue for processing conversations and extracting memories';
COMMENT ON FUNCTION search_memories_by_similarity IS 'Semantic search for memories using vector similarity';
COMMENT ON FUNCTION get_memory_stats IS 'Get statistics about user memories';
