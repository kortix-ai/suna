CREATE OR REPLACE FUNCTION check_renewal_already_processed(
    p_account_id UUID,
    p_period_start BIGINT
) RETURNS JSONB AS $$
DECLARE
    v_existing_record RECORD;
BEGIN
    SELECT * INTO v_existing_record
    FROM public.renewal_processing
    WHERE account_id = p_account_id
    AND period_start = p_period_start;
    
    IF FOUND THEN
        RETURN jsonb_build_object(
            'already_processed', true,
            'processed_by', v_existing_record.processed_by,
            'processed_at', v_existing_record.processed_at,
            'credits_granted', v_existing_record.credits_granted
        );
    ELSE
        RETURN jsonb_build_object(
            'already_processed', false
        );
    END IF;
END;
$$ LANGUAGE plpgsql;
