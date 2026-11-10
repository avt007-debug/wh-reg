-- Purchases entered by staff now wait for the owner's approval before they add
-- stock. The new enum value must be committed before any function uses it, so
-- it lives in its own migration.
ALTER TYPE txn_status ADD VALUE IF NOT EXISTS 'PENDING' BEFORE 'POSTED';
