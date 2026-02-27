INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'staged-files',
    'staged-files',
    false,
    52428800,
    ARRAY[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.presentation',
        'application/rtf',
        'application/epub+zip',
  
        'text/plain',
        'text/csv',
        'text/markdown',
        'text/html',
        'text/css',
        'text/javascript',
        'text/typescript',
        'text/x-python',
        'text/x-java',
        'text/x-c',
        'text/x-c++',
        'text/x-csharp',
        'text/x-go',
        'text/x-rust',
        'text/x-ruby',
        'text/x-php',
        'text/x-swift',
        'text/x-kotlin',
        'text/x-scala',
        'text/x-shellscript',
        'text/x-sql',
        'text/x-yaml',
        'text/x-toml',
        'text/xml',

        'application/json',
        'application/xml',
        'application/javascript',
        'application/typescript',
        'application/x-python-code',
        'application/x-httpd-php',
        'application/x-sh',
        'application/x-yaml',
        'application/toml',
        'application/sql',

        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',

        'application/zip',
        'application/x-tar',
        'application/gzip',
        'application/x-7z-compressed',
        'application/x-rar-compressed',

        'application/octet-stream'
    ]::text[]
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.staged_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL UNIQUE,
    account_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    parsed_content TEXT,
    image_url TEXT,
    parse_status TEXT DEFAULT 'pending' CHECK (parse_status IN ('pending', 'parsing', 'completed', 'failed')),
    thread_id UUID REFERENCES public.threads(thread_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
    CONSTRAINT valid_file_size CHECK (file_size > 0 AND file_size <= 52428800)
);

CREATE INDEX IF NOT EXISTS idx_staged_files_account_id ON public.staged_files(account_id);
CREATE INDEX IF NOT EXISTS idx_staged_files_file_id ON public.staged_files(file_id);
CREATE INDEX IF NOT EXISTS idx_staged_files_thread_id ON public.staged_files(thread_id);
CREATE INDEX IF NOT EXISTS idx_staged_files_expires_at ON public.staged_files(expires_at);

ALTER TABLE public.staged_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own staged files"
    ON public.staged_files
    FOR SELECT
    USING (auth.uid() = account_id);

CREATE POLICY "Users can insert their own staged files"
    ON public.staged_files
    FOR INSERT
    WITH CHECK (auth.uid() = account_id);

CREATE POLICY "Users can update their own staged files"
    ON public.staged_files
    FOR UPDATE
    USING (auth.uid() = account_id);

CREATE POLICY "Users can delete their own staged files"
    ON public.staged_files
    FOR DELETE
    USING (auth.uid() = account_id);

CREATE POLICY "Users can upload to their own folder in staged-files"
    ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'staged-files' AND
        (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can read their own files in staged-files"
    ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'staged-files' AND
        (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can delete their own files in staged-files"
    ON storage.objects
    FOR DELETE
    USING (
        bucket_id = 'staged-files' AND
        (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE OR REPLACE FUNCTION cleanup_expired_staged_files()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    file_record RECORD;
BEGIN
    FOR file_record IN 
        SELECT id, storage_path 
        FROM public.staged_files 
        WHERE expires_at < NOW() AND thread_id IS NULL
    LOOP
        DELETE FROM storage.objects 
        WHERE bucket_id = 'staged-files' 
        AND name = file_record.storage_path;
        
        DELETE FROM public.staged_files WHERE id = file_record.id;
    END LOOP;
END;
$$;

SELECT cron.schedule(
    'cleanup-expired-staged-files',
    '0 * * * *',
    $$SELECT cleanup_expired_staged_files()$$
);

GRANT ALL ON public.staged_files TO authenticated;
GRANT ALL ON public.staged_files TO service_role;
