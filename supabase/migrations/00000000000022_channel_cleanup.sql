-- Channel schema cleanup
-- Remove dead session_strategy and rename system_prompt -> instructions.

ALTER TABLE IF EXISTS kortix.channel_configs
  DROP COLUMN IF EXISTS session_strategy;

DO $$ BEGIN
  IF to_regclass('kortix.channel_configs') IS NOT NULL THEN
    ALTER TABLE kortix.channel_configs
      RENAME COLUMN system_prompt TO instructions;
  END IF;
EXCEPTION
  WHEN undefined_column THEN NULL;
END $$;

DROP TYPE IF EXISTS kortix.session_strategy;
