BEGIN;

-- Create storage bucket for agent default files
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('agent-default-files', 'agent-default-files', false, 524288000) -- 500MB limit
ON CONFLICT (id) DO NOTHING;

-- Storage RLS Policies
-- Users can view files in accounts they belong to (using basejump helper)
CREATE POLICY "Users can view agent default files in their accounts" ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'agent-default-files' AND
        basejump.has_role_on_account((storage.foldername(name))[1]::uuid) = true
    );

-- Users can upload files to accounts they belong to
CREATE POLICY "Users can upload agent default files" ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'agent-default-files' AND
        basejump.has_role_on_account((storage.foldername(name))[1]::uuid) = true
    );

-- Users can update files in accounts they belong to
CREATE POLICY "Users can update agent default files" ON storage.objects
    FOR UPDATE
    USING (
        bucket_id = 'agent-default-files' AND
        basejump.has_role_on_account((storage.foldername(name))[1]::uuid) = true
    );

-- Users can delete files in accounts they belong to
CREATE POLICY "Users can delete agent default files" ON storage.objects
    FOR DELETE
    USING (
        bucket_id = 'agent-default-files' AND
        basejump.has_role_on_account((storage.foldername(name))[1]::uuid) = true
    );

COMMIT;
