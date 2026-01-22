-- Drop staged_files table and related infrastructure - no longer needed with direct sandbox uploads

-- Drop the cleanup function first (it references the table)
DROP FUNCTION IF EXISTS cleanup_expired_staged_files() CASCADE;

-- Remove the cron job
SELECT cron.unschedule('cleanup-expired-staged-files') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-files'
);

-- Drop RLS policies (will be dropped with table, but explicit for clarity)
DROP POLICY IF EXISTS "Users can view their own staged files" ON public.staged_files;
DROP POLICY IF EXISTS "Users can insert their own staged files" ON public.staged_files;
DROP POLICY IF EXISTS "Users can update their own staged files" ON public.staged_files;
DROP POLICY IF EXISTS "Users can delete their own staged files" ON public.staged_files;

-- Drop storage bucket policies
DROP POLICY IF EXISTS "Users can upload to their own folder in staged-files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own files in staged-files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own files in staged-files" ON storage.objects;

-- Drop the table
DROP TABLE IF EXISTS public.staged_files CASCADE;

-- Note: The 'staged-files' storage bucket itself is not dropped here
-- as it may contain existing files. Manual cleanup recommended if needed.
