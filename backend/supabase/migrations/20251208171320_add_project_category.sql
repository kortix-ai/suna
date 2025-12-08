-- Migration: Add category column to projects table for analytics classification

-- 1. Add the category column (default 'Uncategorized' for existing projects)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Uncategorized';

-- 2. Add index for faster analytics queries
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category);