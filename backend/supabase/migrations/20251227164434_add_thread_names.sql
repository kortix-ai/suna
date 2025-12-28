-- Migration: Add name column to threads table
-- This allows each thread/chat to have a descriptive name

-- Add name column to threads table
ALTER TABLE threads ADD COLUMN IF NOT EXISTS name TEXT;


-- Set default for future inserts
ALTER TABLE threads ALTER COLUMN name SET DEFAULT 'New Chat';

-- Add index for faster name searches
CREATE INDEX IF NOT EXISTS idx_threads_name ON threads(name);

-- Add comment
COMMENT ON COLUMN threads.name IS 'Display name for the thread/chat, auto-generated from first message or manually set';

