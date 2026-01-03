-- Sub-Agent Support: Add parent-child thread relationship
-- Enables spawning sub-agents that run in parallel within same project

-- Add parent thread reference for sub-agent threads
ALTER TABLE threads ADD COLUMN IF NOT EXISTS parent_thread_id UUID REFERENCES threads(thread_id) ON DELETE CASCADE;

-- Add depth level for enforcing max spawn depth (0 = main thread, 1 = sub-agent, etc.)
ALTER TABLE threads ADD COLUMN IF NOT EXISTS depth_level INTEGER DEFAULT 0;

-- Index for efficient sub-agent lookups by parent
CREATE INDEX IF NOT EXISTS idx_threads_parent_thread_id ON threads(parent_thread_id) 
WHERE parent_thread_id IS NOT NULL;

-- Index for depth queries (future: if we allow deeper nesting)
CREATE INDEX IF NOT EXISTS idx_threads_depth_level ON threads(depth_level) 
WHERE depth_level > 0;

-- Constraint: depth_level must be non-negative
ALTER TABLE threads ADD CONSTRAINT threads_depth_level_non_negative CHECK (depth_level >= 0);

-- Comment for documentation
COMMENT ON COLUMN threads.parent_thread_id IS 'Reference to parent thread if this is a sub-agent thread';
COMMENT ON COLUMN threads.depth_level IS 'Nesting depth: 0=main thread, 1=sub-agent, 2+=nested sub-agent';

