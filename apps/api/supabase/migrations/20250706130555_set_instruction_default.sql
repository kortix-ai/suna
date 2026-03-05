UPDATE workflow_steps SET type = 'instruction';

ALTER TABLE workflow_steps 
ALTER COLUMN type SET DEFAULT 'instruction';

COMMENT ON COLUMN workflow_steps.type IS 'Step type - defaults to instruction. All steps are now simple instructions with optional tool configuration.';
COMMENT ON COLUMN workflow_steps.config IS 'Step configuration including optional tool_name and tool-specific settings'; 