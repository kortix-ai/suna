-- Validate additive goal evaluation foreign keys after deploy-safe creation.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_goal_observations
  VALIDATE CONSTRAINT project_goal_observations_evaluation_fkey;

ALTER TABLE kortix.project_goal_evaluations
  VALIDATE CONSTRAINT project_goal_evaluations_lifecycle_command_fkey;
