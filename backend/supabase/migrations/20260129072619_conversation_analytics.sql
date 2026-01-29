-- Conversation Analytics Schema
-- Enables AI-powered analysis of agent conversations to understand user behavior

-- ============================================================================
-- TABLES
-- ============================================================================

-- Main analytics table storing LLM-analyzed conversation insights
CREATE TABLE IF NOT EXISTS conversation_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    agent_run_id UUID REFERENCES agent_runs(id),
    account_id UUID NOT NULL,

    -- Sentiment analysis (-1 to 1 scale)
    sentiment_score DECIMAL(3,2),
    sentiment_label TEXT CHECK (sentiment_label IN ('positive', 'neutral', 'negative', 'mixed')),

    -- Frustration detection (0 to 1 scale)
    frustration_score DECIMAL(3,2),
    frustration_signals JSONB DEFAULT '[]',

    -- Churn risk assessment (0 to 1 scale)
    churn_risk_score DECIMAL(3,2),
    churn_signals JSONB DEFAULT '[]',

    -- Topic classification
    primary_topic TEXT,
    topics JSONB DEFAULT '[]',
    intent_type TEXT CHECK (intent_type IN ('question', 'task', 'complaint', 'feature_request', 'chat')),

    -- Feature request detection
    is_feature_request BOOLEAN DEFAULT FALSE,
    feature_request_text TEXT,

    -- Use case details (what users are actually doing)
    is_useful BOOLEAN DEFAULT TRUE,
    use_case_category TEXT,
    use_case_summary TEXT,
    output_type TEXT,
    domain TEXT,
    keywords JSONB DEFAULT '[]',

    -- Conversation metrics
    user_message_count INTEGER,
    assistant_message_count INTEGER,
    conversation_duration_seconds INTEGER,
    agent_run_status TEXT,

    -- Timestamps
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Raw LLM response for debugging
    raw_analysis JSONB DEFAULT '{}',

    -- Embedding for semantic clustering of use cases
    use_case_embedding vector(1536)
);

-- Queue table for async processing
CREATE TABLE IF NOT EXISTS conversation_analytics_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    agent_run_id UUID,
    account_id UUID NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);


-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_conv_analytics_thread ON conversation_analytics(thread_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_account ON conversation_analytics(account_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_analyzed_at ON conversation_analytics(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_sentiment ON conversation_analytics(sentiment_label);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_frustration ON conversation_analytics(frustration_score DESC);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_churn ON conversation_analytics(churn_risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_feature_req ON conversation_analytics(is_feature_request) WHERE is_feature_request;
CREATE INDEX IF NOT EXISTS idx_conv_analytics_is_useful ON conversation_analytics(is_useful);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_primary_topic ON conversation_analytics(primary_topic);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_intent ON conversation_analytics(intent_type);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_output_type ON conversation_analytics(output_type);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_domain ON conversation_analytics(domain);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_use_case ON conversation_analytics USING gin (to_tsvector('english', use_case_summary));

-- Vector index for embedding similarity search (requires pgvector extension)
CREATE INDEX IF NOT EXISTS idx_conv_analytics_embedding ON conversation_analytics
    USING ivfflat (use_case_embedding vector_cosine_ops)
    WITH (lists = 100);

-- Indexes for the queue table
CREATE INDEX IF NOT EXISTS idx_analytics_queue_status ON conversation_analytics_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_queue_thread ON conversation_analytics_queue(thread_id);


-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to increment retry attempts (called by analytics worker)
CREATE OR REPLACE FUNCTION increment_analytics_attempts(queue_id UUID)
RETURNS void AS $$
BEGIN
    UPDATE conversation_analytics_queue
    SET attempts = attempts + 1
    WHERE id = queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE conversation_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_analytics_queue ENABLE ROW LEVEL SECURITY;

-- Only super_admins can read analytics data
CREATE POLICY "super_admin_select_analytics" ON conversation_analytics
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_roles.user_id = auth.uid()
            AND user_roles.role = 'super_admin'
        )
    );

-- Only super_admins can read queue status
CREATE POLICY "super_admin_select_queue" ON conversation_analytics_queue
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_roles.user_id = auth.uid()
            AND user_roles.role = 'super_admin'
        )
    );
