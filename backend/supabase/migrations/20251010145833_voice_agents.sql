CREATE TABLE IF NOT EXISTS public.vapi_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id TEXT NOT NULL UNIQUE,
    agent_id UUID REFERENCES public.agents(agent_id) ON DELETE SET NULL,
    thread_id UUID REFERENCES public.threads(thread_id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ringing', 'in-progress', 'completed', 'ended', 'failed')),
    duration_seconds INTEGER,
    transcript JSONB,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vapi_calls_call_id ON public.vapi_calls(call_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_thread_id ON public.vapi_calls(thread_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent_id ON public.vapi_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created_at ON public.vapi_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_status ON public.vapi_calls(status);

CREATE OR REPLACE FUNCTION public.update_vapi_calls_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_vapi_calls_updated_at
    BEFORE UPDATE ON public.vapi_calls
    FOR EACH ROW
    EXECUTE FUNCTION public.update_vapi_calls_updated_at();

COMMENT ON TABLE public.vapi_calls IS 'Stores Vapi AI voice call metadata and transcripts';
COMMENT ON COLUMN public.vapi_calls.call_id IS 'Unique identifier from Vapi API';
COMMENT ON COLUMN public.vapi_calls.agent_id IS 'Optional reference to the agent that initiated/handled the call';
COMMENT ON COLUMN public.vapi_calls.thread_id IS 'Optional reference to the conversation thread associated with this call';
COMMENT ON COLUMN public.vapi_calls.direction IS 'Call direction: inbound or outbound';
COMMENT ON COLUMN public.vapi_calls.status IS 'Current call status';
COMMENT ON COLUMN public.vapi_calls.duration_seconds IS 'Call duration in seconds';
COMMENT ON COLUMN public.vapi_calls.transcript IS 'JSON array of conversation transcript messages';

