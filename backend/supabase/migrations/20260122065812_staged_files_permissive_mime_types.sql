-- Allow ALL mime types in staged-files bucket
-- Setting allowed_mime_types to NULL removes all restrictions

UPDATE storage.buckets
SET allowed_mime_types = NULL
WHERE id = 'staged-files';
