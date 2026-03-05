BEGIN;

CREATE TABLE IF NOT EXISTS public.file_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID,
    thread_id UUID REFERENCES public.threads(thread_id) ON DELETE CASCADE,
    agent_id UUID REFERENCES public.agents(agent_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    bucket_name VARCHAR(255) NOT NULL,
    storage_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    content_type VARCHAR(255),
    signed_url TEXT,
    url_expires_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT file_uploads_bucket_name_check CHECK (bucket_name IN ('file-uploads', 'browser-screenshots')),
    CONSTRAINT file_uploads_file_size_check CHECK (file_size > 0),
    CONSTRAINT file_uploads_original_filename_check CHECK (LENGTH(TRIM(original_filename)) > 0)
);

ALTER TABLE public.file_uploads ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_file_uploads_updated_at ON public.file_uploads;
CREATE TRIGGER update_file_uploads_updated_at
    BEFORE UPDATE ON public.file_uploads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_file_uploads_account_id ON public.file_uploads(account_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_thread_id ON public.file_uploads(thread_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_agent_id ON public.file_uploads(agent_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_created_at ON public.file_uploads(created_at);

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES (
    'file-uploads',
    'file-uploads', 
    false,
    NULL,
    52428800
)
ON CONFLICT (id) DO UPDATE SET public = false;

ALTER TABLE public.file_uploads 
ADD CONSTRAINT file_uploads_user_storage_unique 
UNIQUE(user_id, bucket_name, storage_path);

CREATE INDEX IF NOT EXISTS idx_file_uploads_user_id ON public.file_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_expires ON public.file_uploads(url_expires_at) WHERE url_expires_at IS NOT NULL;

DROP POLICY IF EXISTS "Authenticated users can upload to file-uploads" ON storage.objects;
DROP POLICY IF EXISTS "file-uploads are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete from file-uploads" ON storage.objects;
DROP POLICY IF EXISTS "Users can update file-uploads" ON storage.objects;

CREATE POLICY "Users can upload to file-uploads" ON storage.objects
FOR INSERT WITH CHECK (
    bucket_id = 'file-uploads' 
    AND auth.role() = 'authenticated'
);

CREATE POLICY "Users can view their own files in file-uploads" ON storage.objects
FOR SELECT USING (
    bucket_id = 'file-uploads' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can delete their own files in file-uploads" ON storage.objects
FOR DELETE USING (
    bucket_id = 'file-uploads' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can update their own files in file-uploads" ON storage.objects
FOR UPDATE USING (
    bucket_id = 'file-uploads' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "Users can view their own file uploads" ON public.file_uploads;
DROP POLICY IF EXISTS "Users can create their own file uploads" ON public.file_uploads;
DROP POLICY IF EXISTS "Users can update their own file uploads" ON public.file_uploads;
DROP POLICY IF EXISTS "Users can delete their own file uploads" ON public.file_uploads;

CREATE POLICY "Users can view their own file uploads" ON public.file_uploads
FOR SELECT USING (
    user_id = auth.uid()
    OR basejump.has_role_on_account(account_id) = true
);

CREATE POLICY "Users can create their own file uploads" ON public.file_uploads
FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND basejump.has_role_on_account(account_id) = true
);

CREATE POLICY "Users can update their own file uploads" ON public.file_uploads
FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own file uploads" ON public.file_uploads
FOR DELETE USING (user_id = auth.uid());


COMMENT ON COLUMN public.file_uploads.user_id IS 'The authenticated user who owns the file';
COMMENT ON COLUMN public.file_uploads.signed_url IS 'Temporary signed URL for secure file access';
COMMENT ON COLUMN public.file_uploads.url_expires_at IS 'Expiration time for the signed URL';

COMMIT; 