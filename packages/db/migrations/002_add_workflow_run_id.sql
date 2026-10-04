-- Add workflow_run_id to executions table for tracking GitHub Actions workflow runs

ALTER TABLE executions ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_executions_workflow_run_id ON executions(workflow_run_id);