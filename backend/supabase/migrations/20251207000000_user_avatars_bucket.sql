BEGIN;

-- Create avatars storage bucket for user profile pictures
INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES (
    'avatars',
    'avatars', 
    true,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']::text[],
    5242880  -- 5MB limit
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;

-- Policy: Authenticated users can upload avatars
CREATE POLICY "Users can upload their own avatar" ON storage.objects
FOR INSERT WITH CHECK (
    bucket_id = 'avatars' 
    AND auth.role() = 'authenticated'
);

-- Policy: Avatars are publicly readable (needed for avatar URLs to work)
CREATE POLICY "Avatars are publicly readable" ON storage.objects
FOR SELECT USING (bucket_id = 'avatars');

-- Policy: Users can update their avatars
CREATE POLICY "Users can update their own avatar" ON storage.objects
FOR UPDATE USING (
    bucket_id = 'avatars' 
    AND auth.role() = 'authenticated'
);

-- Policy: Users can delete their avatars
CREATE POLICY "Users can delete their own avatar" ON storage.objects
FOR DELETE USING (
    bucket_id = 'avatars' 
    AND auth.role() = 'authenticated'
);

COMMIT;

