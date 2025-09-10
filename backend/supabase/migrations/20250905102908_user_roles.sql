CREATE TYPE user_role AS ENUM ('user', 'admin', 'super_admin');

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role user_role NOT NULL DEFAULT 'user',
    granted_by UUID REFERENCES auth.users(id),
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_user_roles_role ON user_roles(role);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own role" ON user_roles
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all roles" ON user_roles
    FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.check_user_role(required_role user_role)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_id = auth.uid()
        AND (
            (required_role = 'user' AND role IN ('user', 'admin', 'super_admin')) OR
            (required_role = 'admin' AND role IN ('admin', 'super_admin')) OR
            (required_role = 'super_admin' AND role = 'super_admin')
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.grant_user_role(
    target_user_id UUID,
    new_role user_role
) RETURNS BOOLEAN AS $$
DECLARE
    granter_role user_role;
BEGIN
    SELECT role INTO granter_role FROM user_roles WHERE user_id = auth.uid();
    
    IF granter_role IS NULL OR 
       (new_role = 'super_admin' AND granter_role != 'super_admin') OR
       (granter_role = 'admin' AND new_role NOT IN ('user', 'admin')) THEN
        RETURN FALSE;
    END IF;
    
    INSERT INTO user_roles (user_id, role, granted_by)
    VALUES (target_user_id, new_role, auth.uid())
    ON CONFLICT (user_id) DO UPDATE
    SET role = new_role, granted_by = auth.uid(), granted_at = NOW();
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 