-- Migration: Add user_message_count column to threads table
-- This denormalization improves analytics query performance from ~50 queries to 1

-- 1. Add the columns
ALTER TABLE threads ADD COLUMN IF NOT EXISTS user_message_count INTEGER DEFAULT 0;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS total_message_count INTEGER DEFAULT 0;

-- 2. Backfill existing data
UPDATE threads t SET 
  user_message_count = COALESCE((
    SELECT COUNT(*) FROM messages m 
    WHERE m.thread_id = t.thread_id AND m.type = 'user'
  ), 0),
  total_message_count = COALESCE((
    SELECT COUNT(*) FROM messages m 
    WHERE m.thread_id = t.thread_id
  ), 0);

-- 3. Create function to update counts on message changes
CREATE OR REPLACE FUNCTION update_thread_message_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE threads SET 
      total_message_count = total_message_count + 1,
      user_message_count = user_message_count + CASE WHEN NEW.type = 'user' THEN 1 ELSE 0 END
    WHERE thread_id = NEW.thread_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE threads SET 
      total_message_count = GREATEST(total_message_count - 1, 0),
      user_message_count = GREATEST(user_message_count - CASE WHEN OLD.type = 'user' THEN 1 ELSE 0 END, 0)
    WHERE thread_id = OLD.thread_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 4. Create trigger
DROP TRIGGER IF EXISTS trigger_update_thread_message_counts ON messages;
CREATE TRIGGER trigger_update_thread_message_counts
AFTER INSERT OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION update_thread_message_counts();

-- 5. Add index for faster analytics queries
CREATE INDEX IF NOT EXISTS idx_threads_user_message_count ON threads(user_message_count);

