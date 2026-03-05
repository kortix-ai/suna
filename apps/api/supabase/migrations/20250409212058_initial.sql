-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create devices table first
CREATE TABLE public.devices (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    account_id UUID NOT NULL,
    name TEXT,
    last_seen TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    is_online BOOLEAN DEFAULT FALSE,
    CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES basejump.accounts(id) ON DELETE CASCADE
);

-- Create recordings table
CREATE TABLE public.recordings (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    account_id UUID NOT NULL,
    device_id UUID NOT NULL,
    preprocessed_file_path TEXT,
    meta JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    name TEXT,
    ui_annotated BOOLEAN DEFAULT FALSE,
    a11y_file_path TEXT,
    audio_file_path TEXT,
    action_annotated BOOLEAN DEFAULT FALSE,
    raw_data_file_path TEXT,
    metadata_file_path TEXT,
    action_training_file_path TEXT,
    CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_device FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE
);

-- Create indexes for foreign keys
CREATE INDEX idx_recordings_account_id ON public.recordings(account_id);
CREATE INDEX idx_recordings_device_id ON public.recordings(device_id);
CREATE INDEX idx_devices_account_id ON public.devices(account_id);

-- Add RLS policies (optional, can be customized as needed)
ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for devices
CREATE POLICY "Account members can delete their own devices"
    ON public.devices FOR DELETE
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can insert their own devices"
    ON public.devices FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can only access their own devices"
    ON public.devices FOR ALL
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can update their own devices"
    ON public.devices FOR UPDATE
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can view their own devices"
    ON public.devices FOR SELECT
    USING (basejump.has_role_on_account(account_id));

-- Create RLS policies for recordings
CREATE POLICY "Account members can delete their own recordings"
    ON public.recordings FOR DELETE
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can insert their own recordings"
    ON public.recordings FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can only access their own recordings"
    ON public.recordings FOR ALL
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can update their own recordings"
    ON public.recordings FOR UPDATE
    USING (basejump.has_role_on_account(account_id));

CREATE POLICY "Account members can view their own recordings"
    ON public.recordings FOR SELECT
    USING (basejump.has_role_on_account(account_id));

-- Note: For threads and messages, you might want different RLS policies
-- depending on your application's requirements


-- Also drop the old function signature
DROP FUNCTION IF EXISTS transfer_device(UUID, UUID, TEXT);


CREATE OR REPLACE FUNCTION transfer_device(
  device_id UUID,      -- Parameter remains UUID
  new_account_id UUID, -- Changed parameter name and implies new ownership target
  device_name TEXT DEFAULT NULL
)
RETURNS SETOF devices AS $$
DECLARE
  device_exists BOOLEAN;
  updated_device devices;
BEGIN
  -- Check if a device with the specified UUID exists
  SELECT EXISTS (
    SELECT 1 FROM devices WHERE id = device_id
  ) INTO device_exists;

  IF device_exists THEN
    -- Device exists: update its account ownership and last_seen timestamp
    UPDATE devices
    SET
      account_id = new_account_id, -- Update account_id instead of user_id
      name = COALESCE(device_name, name),
      last_seen = NOW()
    WHERE id = device_id
    RETURNING * INTO updated_device;

    RETURN NEXT updated_device;
  ELSE
    -- Device doesn't exist; return nothing so the caller can handle creation
    RETURN;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission so that authenticated users can call this function
-- Updated function signature
GRANT EXECUTE ON FUNCTION transfer_device(UUID, UUID, TEXT) TO authenticated;




-- Create the ui_grounding bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('ui_grounding', 'ui_grounding', false)
ON CONFLICT (id) DO NOTHING; -- Avoid error if bucket already exists

-- Create the ui_grounding_trajs bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('ui_grounding_trajs', 'ui_grounding_trajs', false)
ON CONFLICT (id) DO NOTHING; -- Avoid error if bucket already exists

-- Create the recordings bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('recordings', 'recordings', false, null, null) -- Set file size limit and mime types as needed
ON CONFLICT (id) DO NOTHING; -- Avoid error if bucket already exists


-- RLS policies for the 'recordings' bucket
-- Allow members to view files in accounts they belong to
CREATE POLICY "Account members can select recording files"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'recordings' AND
        (storage.foldername(name))[1]::uuid IN (SELECT basejump.get_accounts_with_role())
    );

-- Allow members to insert files into accounts they belong to
CREATE POLICY "Account members can insert recording files"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'recordings' AND
        (storage.foldername(name))[1]::uuid IN (SELECT basejump.get_accounts_with_role())
    );

-- Allow members to update files in accounts they belong to
CREATE POLICY "Account members can update recording files"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'recordings' AND
        (storage.foldername(name))[1]::uuid IN (SELECT basejump.get_accounts_with_role())
    );

-- Allow members to delete files from accounts they belong to
-- Consider restricting this further, e.g., to 'owner' role if needed:
-- (storage.foldername(name))[1]::uuid IN (SELECT basejump.get_accounts_with_role('owner'))
CREATE POLICY "Account members can delete recording files"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'recordings' AND
        (storage.foldername(name))[1]::uuid IN (SELECT basejump.get_accounts_with_role())
    );
