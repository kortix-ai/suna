-- Migration: Create feedback table for storing user feedback
-- This table stores ratings and feedback messages. Can be associated with messages/threads or standalone.

BEGIN;

-- Create feedback table (supports both message-specific and standalone feedback)
CREATE TABLE IF NOT EXISTS feedback (
    feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID REFERENCES threads(thread_id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    rating DECIMAL(2,1) NOT NULL CHECK (rating >= 0.5 AND rating <= 5.0 AND rating % 0.5 = 0),
    feedback_text TEXT,
    help_improve BOOLEAN DEFAULT TRUE,
    context JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create unique constraint for message-specific feedback (only when both thread_id and message_id are provided)
-- Using a partial unique index to only enforce uniqueness when both are not null
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique 
    ON feedback(thread_id, message_id, account_id) 
    WHERE thread_id IS NOT NULL AND message_id IS NOT NULL;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_feedback_thread_id ON feedback(thread_id);
CREATE INDEX IF NOT EXISTS idx_feedback_message_id ON feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_account_id ON feedback(account_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own feedback
DROP POLICY IF EXISTS "Users can view their own feedback" ON feedback;
CREATE POLICY "Users can view their own feedback"
    ON feedback
    FOR SELECT
    USING (auth.uid() = account_id);

-- Policy: Users can insert their own feedback
DROP POLICY IF EXISTS "Users can insert their own feedback" ON feedback;
CREATE POLICY "Users can insert their own feedback"
    ON feedback
    FOR INSERT
    WITH CHECK (auth.uid() = account_id);

-- Policy: Users can update their own feedback
DROP POLICY IF EXISTS "Users can update their own feedback" ON feedback;
CREATE POLICY "Users can update their own feedback"
    ON feedback
    FOR UPDATE
    USING (auth.uid() = account_id)
    WITH CHECK (auth.uid() = account_id);

-- Policy: Users can delete their own feedback
DROP POLICY IF EXISTS "Users can delete their own feedback" ON feedback;
CREATE POLICY "Users can delete their own feedback"
    ON feedback
    FOR DELETE
    USING (auth.uid() = account_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_feedback_updated_at ON feedback;
CREATE TRIGGER update_feedback_updated_at
    BEFORE UPDATE ON feedback
    FOR EACH ROW
    EXECUTE FUNCTION update_feedback_updated_at();

-- Comments
COMMENT ON TABLE feedback IS 'Stores user feedback (ratings and comments). Can be associated with messages/threads or standalone.';
COMMENT ON COLUMN feedback.rating IS 'Rating from 0.5 to 5.0 in 0.5 increments (half stars)';
COMMENT ON COLUMN feedback.feedback_text IS 'Optional text feedback from the user';
COMMENT ON COLUMN feedback.help_improve IS 'Whether the user wants to help improve the service';
COMMENT ON COLUMN feedback.context IS 'Additional context/metadata as JSONB';
COMMENT ON COLUMN feedback.thread_id IS 'Optional thread ID if feedback is associated with a thread';
COMMENT ON COLUMN feedback.message_id IS 'Optional message ID if feedback is associated with a message';

COMMIT;
