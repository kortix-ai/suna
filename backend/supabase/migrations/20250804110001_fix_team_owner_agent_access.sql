-- Migration: Fix team owner agent access
-- This migration updates the RLS policies for the agents table to allow:
-- 1. Team owners to access all agents from team members
-- 2. Admin users to access all agents
-- 3. Regular users to access their own agents and public agents

BEGIN;

-- First, drop existing policies
DROP POLICY IF EXISTS "Users can view their own agents" ON public.agents;
DROP POLICY IF EXISTS "Users can view public agents" ON public.agents;
DROP POLICY IF EXISTS "Users can insert their own agents" ON public.agents;
DROP POLICY IF EXISTS "Users can update their own agents" ON public.agents;
DROP POLICY IF EXISTS "Users can delete their own agents" ON public.agents;

-- Create new policies with team owner access

-- Select policy: Allow access to own agents, public agents, team member agents (for team owners), and all agents (for admins)
CREATE POLICY "Users can view agents they have access to" 
ON public.agents FOR SELECT 
TO authenticated
USING (
  -- Agent owners can see their own agents
  account_id = auth.uid()
  OR
  -- Anyone can see public agents
  is_public = true
  OR
  -- Admin users can see all agents
  EXISTS (
    SELECT 1 FROM basejump.config 
    WHERE config.is_admin = true 
    AND config.user_id = auth.uid()
  )
  OR
  -- Team owners can see all agents from their team members
  EXISTS (
    SELECT 1 
    FROM basejump.account_user au1
    JOIN basejump.account_user au2 ON au1.account_id = au2.account_id
    WHERE au1.user_id = auth.uid() 
    AND au1.account_role = 'owner'
    AND au2.user_id = agents.account_id
  )
);

-- Insert policy: Allow users to create their own agents
CREATE POLICY "Users can insert their own agents" 
ON public.agents FOR INSERT 
TO authenticated
WITH CHECK (account_id = auth.uid());

-- Update policy: Allow access to own agents and team member agents (for team owners)
CREATE POLICY "Users can update agents they have access to" 
ON public.agents FOR UPDATE 
TO authenticated
USING (
  -- Agent owners can update their own agents
  account_id = auth.uid()
  OR
  -- Admin users can update all agents
  EXISTS (
    SELECT 1 FROM basejump.config 
    WHERE config.is_admin = true 
    AND config.user_id = auth.uid()
  )
  OR
  -- Team owners can update all agents from their team members
  EXISTS (
    SELECT 1 
    FROM basejump.account_user au1
    JOIN basejump.account_user au2 ON au1.account_id = au2.account_id
    WHERE au1.user_id = auth.uid() 
    AND au1.account_role = 'owner'
    AND au2.user_id = agents.account_id
  )
)
WITH CHECK (
  -- Agent owners can update their own agents
  account_id = auth.uid()
  OR
  -- Admin users can update all agents
  EXISTS (
    SELECT 1 FROM basejump.config 
    WHERE config.is_admin = true 
    AND config.user_id = auth.uid()
  )
  OR
  -- Team owners can update all agents from their team members
  EXISTS (
    SELECT 1 
    FROM basejump.account_user au1
    JOIN basejump.account_user au2 ON au1.account_id = au2.account_id
    WHERE au1.user_id = auth.uid() 
    AND au1.account_role = 'owner'
    AND au2.user_id = agents.account_id
  )
);

-- Delete policy: Allow access to own agents and team member agents (for team owners)
CREATE POLICY "Users can delete agents they have access to" 
ON public.agents FOR DELETE 
TO authenticated
USING (
  -- Agent owners can delete their own agents
  account_id = auth.uid()
  OR
  -- Admin users can delete all agents
  EXISTS (
    SELECT 1 FROM basejump.config 
    WHERE config.is_admin = true 
    AND config.user_id = auth.uid()
  )
  OR
  -- Team owners can delete all agents from their team members
  EXISTS (
    SELECT 1 
    FROM basejump.account_user au1
    JOIN basejump.account_user au2 ON au1.account_id = au2.account_id
    WHERE au1.user_id = auth.uid() 
    AND au1.account_role = 'owner'
    AND au2.user_id = agents.account_id
  )
);

COMMIT;
