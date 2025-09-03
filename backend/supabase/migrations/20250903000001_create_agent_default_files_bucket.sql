-- Create storage bucket for agent default files
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('agent-default-files', 'agent-default-files', false, 524288000) -- 500MB limit
ON CONFLICT (id) DO NOTHING;

-- Storage RLS Policies
-- Users can view files in accounts they belong to
CREATE POLICY "Users can view agent default files in their accounts" ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'agent-default-files' AND
        EXISTS (
            SELECT 1 FROM user_accounts
            WHERE user_accounts.account_id = (storage.foldername(name))[1]::uuid
            AND user_accounts.user_id = auth.uid()
        )
    );

-- Only account owners can upload files
CREATE POLICY "Account owners can upload agent default files" ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'agent-default-files' AND
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = (storage.foldername(name))[1]::uuid
            AND accounts.owner = auth.uid()
        )
    );

-- Only account owners can update files
CREATE POLICY "Account owners can update agent default files" ON storage.objects
    FOR UPDATE
    USING (
        bucket_id = 'agent-default-files' AND
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = (storage.foldername(name))[1]::uuid
            AND accounts.owner = auth.uid()
        )
    );

-- Only account owners can delete files
CREATE POLICY "Account owners can delete agent default files" ON storage.objects
    FOR DELETE
    USING (
        bucket_id = 'agent-default-files' AND
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = (storage.foldername(name))[1]::uuid
            AND accounts.owner = auth.uid()
        )
    );
