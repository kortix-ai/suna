ALTER TABLE public.staged_files
ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.staged_files.image_url IS 'Public URL of compressed image uploaded to image-uploads bucket for multimodal LLM injection';
