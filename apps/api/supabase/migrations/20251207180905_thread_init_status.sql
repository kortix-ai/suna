DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'thread_status'
  ) THEN
    CREATE TYPE thread_status AS ENUM ('pending', 'initializing', 'ready', 'error');
  END IF;
END
$$;

ALTER TABLE threads ADD COLUMN IF NOT EXISTS status thread_status DEFAULT 'ready';

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_account_status ON threads(account_id, status);

ALTER TABLE threads ADD COLUMN IF NOT EXISTS initialization_error TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS initialization_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS initialization_completed_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN threads.status IS 'Thread initialization status: pending (created, not started), initializing (setup in progress), ready (fully initialized), error (initialization failed)';
COMMENT ON COLUMN threads.initialization_error IS 'Error message if thread initialization failed';
COMMENT ON COLUMN threads.initialization_started_at IS 'When thread initialization started';
COMMENT ON COLUMN threads.initialization_completed_at IS 'When thread initialization completed (successfully or with error)';
