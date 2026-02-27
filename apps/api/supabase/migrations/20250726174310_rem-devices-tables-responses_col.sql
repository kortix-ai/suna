-- Migration: Remove recordings, devices tables and responses field from agent_runs
-- This migration cleans up unused tables and fields

BEGIN;

-- Drop recordings table first (has foreign key to devices)
DROP TABLE IF EXISTS public.recordings CASCADE;

-- Drop devices table
DROP TABLE IF EXISTS public.devices CASCADE;

-- Remove responses column from agent_runs table
ALTER TABLE agent_runs DROP COLUMN IF EXISTS responses;

COMMIT; 