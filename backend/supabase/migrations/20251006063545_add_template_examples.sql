BEGIN;

ALTER TABLE agent_templates
ADD COLUMN IF NOT EXISTS usage_examples JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agent_templates_usage_examples 
ON agent_templates USING gin(usage_examples);

COMMENT ON COLUMN agent_templates.usage_examples IS 
'Example conversation demonstrating agent usage. Array of message objects with role (user/assistant), content, and optional tool_calls array';

COMMIT;
