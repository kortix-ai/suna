BEGIN;

-- Update file-uploads bucket size limit from 50MB to 500MB
UPDATE storage.buckets 
SET file_size_limit = 524288000  -- 500MB in bytes
WHERE id = 'file-uploads';

-- Verify the update
DO $$
DECLARE
    current_limit BIGINT;
BEGIN
    SELECT file_size_limit INTO current_limit 
    FROM storage.buckets 
    WHERE id = 'file-uploads';
    
    IF current_limit = 524288000 THEN
        RAISE NOTICE 'Successfully updated file-uploads bucket limit to 500MB (% bytes)', current_limit;
    ELSE
        RAISE EXCEPTION 'Failed to update file-uploads bucket limit. Current limit: % bytes', current_limit;
    END IF;
END $$;

COMMIT;
