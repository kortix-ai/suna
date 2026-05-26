ALTER TABLE kortix.credit_accounts
  DROP COLUMN IF EXISTS included_compute_balance,
  DROP COLUMN IF EXISTS included_yolo_balance,
  DROP COLUMN IF EXISTS included_compute_per_seat_usd,
  DROP COLUMN IF EXISTS included_yolo_per_seat_usd;
