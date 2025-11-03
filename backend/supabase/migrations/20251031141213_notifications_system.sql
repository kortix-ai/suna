BEGIN;

-- =====================================================
-- NOTIFICATION SYSTEM MIGRATION
-- =====================================================
-- This migration creates the notification system for:
-- 1. Storing notifications in the database
-- 2. Tracking notification delivery status (email, push)
-- 3. Managing user notification preferences
-- 4. Supporting agent-triggered and admin-triggered notifications

-- =====================================================
-- 1. NOTIFICATIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Notification content
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'info', -- 'info', 'success', 'warning', 'error', 'agent_complete'
    category VARCHAR(50) DEFAULT NULL, -- 'agent', 'system', 'billing', 'admin', etc.
    
    -- Related entities (for linking to threads, agent runs, etc.)
    thread_id UUID REFERENCES threads(thread_id) ON DELETE SET NULL,
    agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    related_entity_type VARCHAR(50) DEFAULT NULL,
    related_entity_id UUID DEFAULT NULL,
    
    -- Global notification tracking (for admin notifications)
    is_global BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- For admin notifications
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Delivery status
    email_sent BOOLEAN DEFAULT FALSE,
    email_sent_at TIMESTAMPTZ,
    email_error TEXT, -- Track email delivery errors
    
    push_sent BOOLEAN DEFAULT FALSE,
    push_sent_at TIMESTAMPTZ,
    push_error TEXT, -- Track push delivery errors
    
    -- Retry tracking
    retry_count INTEGER DEFAULT 0,
    last_retry_at TIMESTAMPTZ,
    
    -- Read status
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_account_id ON notifications(account_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_thread_id ON notifications(thread_id);
CREATE INDEX IF NOT EXISTS idx_notifications_agent_run_id ON notifications(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- Composite index for user notifications query
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- =====================================================
-- 2. USER NOTIFICATION PREFERENCES TABLE (SIMPLIFIED)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    -- Global toggles
    email_enabled BOOLEAN DEFAULT TRUE,
    push_enabled BOOLEAN DEFAULT TRUE,
    
    -- Category-level preferences (JSONB for flexibility)
    -- Default: all categories enabled
    email_categories JSONB DEFAULT '{"agent": true, "system": true, "billing": true, "admin": true}'::jsonb,
    push_categories JSONB DEFAULT '{"agent": true, "system": true, "billing": true, "admin": true}'::jsonb,
    
    -- Push token storage (for Expo push notifications)
    push_token TEXT,
    push_token_updated_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_account_id ON user_notification_preferences(account_id);
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_push_token ON user_notification_preferences(push_token) WHERE push_token IS NOT NULL;

-- Index for global notifications
CREATE INDEX IF NOT EXISTS idx_notifications_is_global ON notifications(is_global) WHERE is_global = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_created_by ON notifications(created_by) WHERE created_by IS NOT NULL;

-- =====================================================
-- 4. ROW LEVEL SECURITY POLICIES
-- =====================================================

-- Enable RLS on notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can view their own notifications
CREATE POLICY "Users can view their own notifications" ON notifications
    FOR SELECT USING (auth.uid() = user_id);

-- Users can update their own notifications (e.g., mark as read)
CREATE POLICY "Users can update their own notifications" ON notifications
    FOR UPDATE USING (auth.uid() = user_id);

-- Service role can manage all notifications
CREATE POLICY "Service role can manage all notifications" ON notifications
    FOR ALL USING (auth.role() = 'service_role');

-- Enable RLS on user_notification_preferences
ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can view and update their own preferences
CREATE POLICY "Users can manage their own notification preferences" ON user_notification_preferences
    FOR ALL USING (auth.uid() = user_id);

-- Service role can manage all preferences
CREATE POLICY "Service role can manage all notification preferences" ON user_notification_preferences
    FOR ALL USING (auth.role() = 'service_role');

-- =====================================================
-- 5. HELPER FUNCTIONS
-- =====================================================

-- Function to get user email
CREATE OR REPLACE FUNCTION get_user_email_for_notification(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    user_email TEXT;
BEGIN
    SELECT email INTO user_email
    FROM auth.users
    WHERE id = p_user_id;
    
    IF user_email IS NULL THEN
        SELECT 
            COALESCE(
                raw_user_meta_data->>'email',
                raw_user_meta_data->>'user_email',
                email
            ) INTO user_email
        FROM auth.users
        WHERE id = p_user_id;
    END IF;
    
    RETURN user_email;
END;
$$;

GRANT EXECUTE ON FUNCTION get_user_email_for_notification(UUID) TO service_role;

-- Function to get or create user notification preferences
CREATE OR REPLACE FUNCTION get_or_create_notification_preferences(p_user_id UUID, p_account_id UUID)
RETURNS user_notification_preferences
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    prefs user_notification_preferences;
BEGIN
    -- Try to get existing preferences
    SELECT * INTO prefs
    FROM user_notification_preferences
    WHERE user_id = p_user_id;
    
    -- If not found, create default preferences
    IF prefs IS NULL THEN
        INSERT INTO user_notification_preferences (user_id, account_id)
        VALUES (p_user_id, p_account_id)
        RETURNING * INTO prefs;
    END IF;
    
    RETURN prefs;
END;
$$;

GRANT EXECUTE ON FUNCTION get_or_create_notification_preferences(UUID, UUID) TO service_role;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_notifications_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Trigger for notifications updated_at
CREATE TRIGGER notifications_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_notifications_updated_at();

-- Trigger for user_notification_preferences updated_at
CREATE TRIGGER user_notification_preferences_updated_at
    BEFORE UPDATE ON user_notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_notifications_updated_at();


COMMIT;
