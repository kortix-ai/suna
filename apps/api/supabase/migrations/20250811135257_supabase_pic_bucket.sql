BEGIN;

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES (
    'agent-profile-images',
    'agent-profile-images', 
    true,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']::text[],
    5242880
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can upload agent profile images" ON storage.objects;
DROP POLICY IF EXISTS "Agent profile images are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete agent profile images" ON storage.objects;

CREATE POLICY "Users can upload agent profile images" ON storage.objects
FOR INSERT WITH CHECK (
    bucket_id = 'agent-profile-images' 
    AND auth.role() = 'authenticated'
);

CREATE POLICY "Agent profile images are publicly readable" ON storage.objects
FOR SELECT USING (bucket_id = 'agent-profile-images');

CREATE POLICY "Users can delete agent profile images" ON storage.objects
FOR DELETE USING (
    bucket_id = 'agent-profile-images' 
    AND auth.role() = 'authenticated'
);

COMMIT; 