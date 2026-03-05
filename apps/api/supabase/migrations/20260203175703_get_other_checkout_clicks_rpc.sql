-- RPC to count "other" checkout clicks (free tier users who signed up before range but clicked during)

CREATE OR REPLACE FUNCTION get_other_checkout_clicks_count(
    date_from TIMESTAMPTZ,
    date_to TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result INTEGER;
BEGIN
    SELECT COUNT(DISTINCT cc.user_id) INTO result
    FROM checkout_clicks cc
    JOIN basejump.accounts a ON a.primary_owner_user_id = cc.user_id AND a.personal_account = true
    LEFT JOIN credit_accounts ca ON ca.account_id = a.id
    WHERE cc.clicked_at >= date_from
      AND cc.clicked_at <= date_to
      AND a.created_at < date_from  -- signed up BEFORE the range
      AND COALESCE(ca.tier, 'free') IN ('free', 'none');  -- still on free tier

    RETURN COALESCE(result, 0);
END;
$$;
