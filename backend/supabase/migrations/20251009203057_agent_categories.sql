BEGIN;

ALTER TABLE agent_templates
ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_agent_templates_categories 
ON agent_templates USING gin(categories);

COMMENT ON COLUMN agent_templates.categories IS 
'Categories for organizing agent templates in the marketplace. An agent template can belong to multiple categories.';

COMMIT;
