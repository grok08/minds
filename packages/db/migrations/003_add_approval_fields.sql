-- Add approval-related fields for Phase 4 Human-in-the-Loop

-- Add approval fields to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_payload JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;

-- Add decision and continuation_data to approvals table
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision TEXT CHECK (decision IN ('approved', 'rejected'));
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS continuation_data JSONB;

-- Update existing approvals to have a decision based on status
UPDATE approvals SET decision = status WHERE decision IS NULL AND status IN ('approved', 'rejected');