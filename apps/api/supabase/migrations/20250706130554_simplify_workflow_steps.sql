DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'instruction' AND enumtypid = 'workflow_step_type'::regtype) THEN
        ALTER TYPE workflow_step_type ADD VALUE 'instruction';
    END IF;
END $$; 