CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    circuit_name TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_time TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state_updated_at 
ON circuit_breaker_state(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state_state 
ON circuit_breaker_state(state) 
WHERE state != 'closed';

COMMENT ON TABLE circuit_breaker_state IS 
'Distributed circuit breaker state shared across all backend instances. Prevents all instances from hammering external services when failures occur.';

COMMENT ON COLUMN circuit_breaker_state.circuit_name IS 
'Unique identifier for the circuit (e.g., stripe_api, external_api_name)';

COMMENT ON COLUMN circuit_breaker_state.state IS 
'Current circuit state: closed (normal), open (failing, blocking requests), half_open (testing recovery)';

COMMENT ON COLUMN circuit_breaker_state.failure_count IS 
'Number of consecutive failures. Reset to 0 on success or when circuit closes.';

COMMENT ON COLUMN circuit_breaker_state.last_failure_time IS 
'Timestamp of the most recent failure. Used to determine when to attempt recovery.';

INSERT INTO circuit_breaker_state (circuit_name, state, failure_count, last_failure_time)
VALUES ('stripe_api', 'closed', 0, NULL)
ON CONFLICT (circuit_name) DO NOTHING;

CREATE OR REPLACE FUNCTION cleanup_stale_circuit_breakers() RETURNS INTEGER AS $$
DECLARE
    v_reset_count INTEGER;
BEGIN
    UPDATE circuit_breaker_state
    SET 
        state = 'closed',
        failure_count = 0,
        last_failure_time = NULL,
        updated_at = NOW()
    WHERE 
        state IN ('open', 'half_open')
        AND updated_at < NOW() - INTERVAL '1 hour';
    
    GET DIAGNOSTICS v_reset_count = ROW_COUNT;
    
    IF v_reset_count > 0 THEN
        RAISE NOTICE 'Reset % stale circuit breaker(s)', v_reset_count;
    END IF;
    
    RETURN v_reset_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_stale_circuit_breakers IS 
'Automatically resets circuit breakers that have been stuck in OPEN/HALF_OPEN state for over 1 hour. Run periodically as a maintenance job.';

CREATE OR REPLACE VIEW v_circuit_breaker_status AS
SELECT 
    circuit_name,
    state,
    failure_count,
    last_failure_time,
    CASE 
        WHEN last_failure_time IS NOT NULL THEN 
            EXTRACT(EPOCH FROM (NOW() - last_failure_time)) 
        ELSE NULL 
    END AS seconds_since_failure,
    updated_at,
    CASE 
        WHEN state = 'open' AND last_failure_time IS NOT NULL THEN
            GREATEST(0, 60 - EXTRACT(EPOCH FROM (NOW() - last_failure_time)))
        ELSE NULL
    END AS seconds_until_retry,
    CASE
        WHEN state = 'closed' THEN '✅ Healthy'
        WHEN state = 'open' THEN '🔴 OPEN - Blocking requests'
        WHEN state = 'half_open' THEN '🟡 Testing recovery'
    END AS status_display
FROM circuit_breaker_state
ORDER BY 
    CASE state
        WHEN 'open' THEN 1
        WHEN 'half_open' THEN 2
        WHEN 'closed' THEN 3
    END,
    circuit_name;

COMMENT ON VIEW v_circuit_breaker_status IS 
'Human-readable view of circuit breaker status across all circuits. Use this for monitoring dashboards.';

CREATE OR REPLACE FUNCTION reset_circuit_breaker(p_circuit_name TEXT) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE circuit_breaker_state
    SET 
        state = 'closed',
        failure_count = 0,
        last_failure_time = NULL,
        updated_at = NOW()
    WHERE circuit_name = p_circuit_name;
    
    IF FOUND THEN
        RAISE NOTICE 'Reset circuit breaker: %', p_circuit_name;
        RETURN TRUE;
    ELSE
        RAISE NOTICE 'Circuit breaker not found: %', p_circuit_name;
        RETURN FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reset_circuit_breaker IS 
'Manually reset a circuit breaker to CLOSED state. Use this for emergency recovery: SELECT reset_circuit_breaker(''stripe_api'');';

ALTER TABLE circuit_breaker_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to circuit breaker"
    ON circuit_breaker_state
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Authenticated users can read circuit breaker state"
    ON circuit_breaker_state
    FOR SELECT
    TO authenticated
    USING (true);

COMMENT ON POLICY "Service role has full access to circuit breaker" ON circuit_breaker_state IS
'Backend service needs full read/write access to update circuit state';

COMMENT ON POLICY "Authenticated users can read circuit breaker state" ON circuit_breaker_state IS
'Logged-in users can view circuit status for debugging (via admin API with proper auth checks)';

DO $$ 
BEGIN
    RAISE NOTICE '✅ Distributed Circuit Breaker Setup Complete:';
    RAISE NOTICE '   - circuit_breaker_state table created';
    RAISE NOTICE '   - stripe_api circuit initialized';
    RAISE NOTICE '   - Cleanup and monitoring functions added';
    RAISE NOTICE '   - RLS enabled with service_role access';
    RAISE NOTICE '';
    RAISE NOTICE '🔒 DISTRIBUTED CIRCUIT BREAKER ACTIVE:';
    RAISE NOTICE '   • All backend instances now share circuit state';
    RAISE NOTICE '   • When one instance detects failures, ALL instances stop';
    RAISE NOTICE '   • Automatic recovery after 60 seconds';
    RAISE NOTICE '   • Manual reset: SELECT reset_circuit_breaker(''stripe_api'');';
    RAISE NOTICE '   • Monitor status: SELECT * FROM v_circuit_breaker_status;';
END $$;

