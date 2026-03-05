-- Migration: Enable realtime updates for projects table
-- This migration enables realtime subscriptions for the projects table

BEGIN;

-- Enable realtime for projects table
ALTER PUBLICATION supabase_realtime ADD TABLE projects;

COMMIT;