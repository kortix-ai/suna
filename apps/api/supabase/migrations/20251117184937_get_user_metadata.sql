BEGIN;

-- Create function to get user metadata (including locale) from auth.users
CREATE OR REPLACE FUNCTION public.get_user_metadata(user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    user_metadata JSONB;
BEGIN
    SELECT raw_user_meta_data INTO user_metadata
    FROM auth.users
    WHERE id = user_id;
    
    RETURN COALESCE(user_metadata, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_metadata(UUID) TO authenticated, service_role;

COMMIT;

