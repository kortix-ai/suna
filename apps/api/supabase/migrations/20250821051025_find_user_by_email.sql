BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_account_by_email(email_input text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    account_data json;
BEGIN
    SELECT json_build_object(
        'id', a.id,
        'name', a.name,
        'slug', a.slug,
        'primary_owner_user_id', a.primary_owner_user_id
    ) INTO account_data
    FROM auth.users u
    JOIN basejump.accounts a ON a.primary_owner_user_id = u.id
    WHERE LOWER(u.email) = LOWER(email_input)
      AND a.personal_account = true
    LIMIT 1;

    RETURN account_data;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_account_by_email(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_user_account_by_email(text) IS 'Gets user account by email address. Used by admin scripts to install Suna agents.';

COMMIT; 